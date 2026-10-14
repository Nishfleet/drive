import { AwsClient } from "aws4fetch";
import { FETCH_TIMEOUT_MS, fetchWithTimeoutAndRetry } from "./fetch-retry.js";
import {
  fileKind,
  isoStamp,
  isRestorable,
  parseTrashName,
  RECENTLY_DELETED_DAYS,
  splitEntries,
} from "./files.js";
import {
  assertDestinationEmpty,
  bareEtag,
  multipartCopy,
  REMOVE_BATCH_LIMIT,
  SINGLE_COPY_LIMIT,
  sourceSize,
} from "./files-s3-copy.js";
import { ChangedUnderUsError, quotedEntityTag } from "./files-scope.js";
import { contentMd5 } from "./s3.js";
import {
  computeHiddenAt,
  decodeEntities,
  nextContinuationToken,
  nextVersionMarkers,
  parseListVersions,
  tagValue,
  versionMarkers,
} from "./s3-listing.js";
import { formatBytes } from "./status.js";
import { DAY_MS } from "./units.js";

/** @typedef {import("./files-memory.js").FileEntry} FileEntry */
/** @typedef {import("./files-memory.js").StorageVersion} StorageVersion */
/** @typedef {import("./files-memory.js").FileStore} FileStore */

/**
 * The storage the issue names: plain S3 over HTTP, pointed at `rclone serve s3`
 * on the build host and at a real vendor's endpoint (iDrive e2, eu-west-3)
 * when `credentials` and `region` are given. The four S3 calls the page needs
 * are the four store methods; signing is `aws4fetch` (`AwsClient`), the same
 * stock signer the api Worker signs its bucket calls with, so a real account
 * speaks through the same FileStore interface as the stand-in. The keys are
 * exactly the paths the store is given — the account prefix is applied by
 * scopeStore, which is the one place it is applied.
 *
 * `bucket` is one shared namespace (the local stand-in, and tests that pin a
 * name). `bucketFor` picks a bucket from the storage key, which is how the
 * live Files page and share links follow drive#371: each account's objects
 * live in `drv-<id>`, the same name the key provider mints.
 *
 * Without a credential the requests are unsigned, which is what the local
 * stand-in answers; with one every request is signed, because a real endpoint
 * answers an unsigned call with a redirect to its website, not with a listing.
 * @param {{endpoint: string, bucket?: string, bucketFor?: (key: string) => string,
 *   fetchImpl?: typeof fetch, region?: string, timeoutMs?: number,
 *   credentials?: {accessKeyId: string, secretAccessKey: string, sessionToken?: string}}} config
 *   `timeoutMs` is the per-call deadline every storage request runs under
 *   (core/fetch-retry.js); the default is the module's FETCH_TIMEOUT_MS, and
 *   a test passes a small one to prove the abort in milliseconds.
 * @returns {FileStore}
 */
export function createS3Store(config) {
  const { endpoint, bucket, bucketFor, region, credentials, fetchImpl = fetch } = config;
  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : FETCH_TIMEOUT_MS;
  if (!endpoint || (!bucket && typeof bucketFor !== "function")) {
    throw new Error("createS3Store needs an endpoint and a bucket.");
  }
  if (Boolean(credentials) !== Boolean(region)) {
    throw new Error("createS3Store needs both a region and a credential, or neither.");
  }
  const aws = credentials
    ? new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region,
        service: "s3",
        retries: 0,
      })
    : null;
  /** @param {string} path */
  const bucketOf = (path) =>
    typeof bucketFor === "function" ? bucketFor(path) : /** @type {string} */ (bucket);
  /** @param {string} path */
  const baseFor = (path) => `${String(endpoint).replace(/\/$/, "")}/${bucketOf(path)}`;
  /** @param {string} path */
  const urlFor = (path) => `${baseFor(path)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  /**
   * The one request path every method below uses, so a store is either fully
   * signed or fully unsigned. A write body is sent as it is: aws4fetch signs
   * S3 with `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` (it sets that header
   * itself), so a stream is never read into isolate memory to hash it
   * (drive#539). Fetch-retry already skips the 5xx retry on a stream, because
   * the first attempt spends it. Signing is `aws.sign` then `fetchImpl`, the
   * same path `createS3Client` uses, so a test can still inject fetch and a
   * credentialed store never bypasses it through `aws.fetch`. Every caller
   * below passes a string URL. The send carries the store's one timeout and
   * one retry (core/fetch-retry.js): a stalled socket answers named after 15 s,
   * and a 5xx on a replayable body gets exactly one retried call. The signing
   * is inside the retry's per-attempt send, because a second attempt must sign
   * again - the first attempt's signed Request has a body stream already
   * consumed and its own x-amz-date, and replaying it is a SignatureDoesNotMatch,
   * not a retry.
   *
   * @type {(input: string | URL | Request, init?: RequestInit) => Promise<Response>}
   */
  const request =
    aws === null
      ? (input, init = {}) =>
          fetchWithTimeoutAndRetry(fetchImpl, input, init, {
            timeoutMs,
            label: "storage request",
          })
      : async (input, init = {}) => {
          const opts = /** @type {any} */ ({ ...init });
          if (opts.body === null) {
            delete opts.body;
          }
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof Request !== "undefined" && input instanceof Request
                  ? input.url
                  : String(input);
          return fetchWithTimeoutAndRetry(
            /** @type {typeof fetch} */ (
              /** @param {string} u @param {RequestInit} [i] */
              async (u, i) => fetchImpl(await aws.sign(u, i ?? {}))
            ),
            url,
            opts,
            { timeoutMs, label: "storage request" },
          );
        };

  return {
    /** @param {string} path */
    async list(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1)));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          throw new Error(
            "storage list repeated continuation-token; the folder is not fully listed",
          );
        }
        seen = token;
      }
    },
    async listPage(path, options = {}) {
      const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), 1_000);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const query =
        `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
        `&max-keys=${limit}` +
        (options.cursor ? `&continuation-token=${encodeURIComponent(options.cursor)}` : "");
      const response = await request(`${baseFor(prefix)}${query}`);
      if (response.status === 404) {
        return { entries: [], nextCursor: null };
      }
      if (!response.ok) {
        throw new Error(`storage list failed with ${response.status}`);
      }
      const xml = await response.text();
      return {
        entries: parseListObjects(xml, prefix, prefix.slice(0, -1)),
        nextCursor: nextContinuationToken(xml),
      };
    },
    async listAll(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1), { deep: true }));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          throw new Error(
            "storage list repeated continuation-token; the folder is not fully listed",
          );
        }
        seen = token;
      }
    },
    async stat(path) {
      const response = await request(urlFor(path), { method: "HEAD" });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`storage stat failed with ${response.status}`);
      }
      return {
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length") || 0),
        etag: response.headers.get("etag"),
      };
    },
    async read(path, options = {}) {
      const headers = {};
      if (options.range) {
        headers.range = options.range;
      }
      if (options.ifNoneMatch) {
        headers["if-none-match"] = options.ifNoneMatch;
      }
      const response = await request(
        urlFor(path),
        Object.keys(headers).length > 0 ? { headers } : {},
      );
      const status = response.status;
      if (status === 404) {
        return null;
      }
      if (![200, 206, 304, 416].includes(status)) {
        throw new Error(`storage read failed with ${status}`);
      }
      const contentRange =
        status === 206 ? (response.headers.get("content-range") ?? undefined) : undefined;
      const rangeTotal = contentRange ? Number(contentRange.split("/")[1]) : Number.NaN;
      const contentLength = Number(response.headers.get("content-length") || 0);
      return {
        status,
        body:
          status === 304 || status === 416 ? null : /** @type {ReadableStream} */ (response.body),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number.isFinite(rangeTotal) ? rangeTotal : contentLength,
        etag: response.headers.get("etag"),
        ...(contentRange ? { contentRange } : {}),
        ...(status !== 200 ? { contentLength } : {}),
      };
    },
    async write(path, body, contentType, options = {}) {
      /** @type {Record<string, string>} */
      const headers = { "content-type": contentType };
      if (typeof options.contentLength === "number" && Number.isFinite(options.contentLength)) {
        headers["content-length"] = String(options.contentLength);
      } else if (aws !== null && body instanceof ReadableStream) {
        throw new TypeError("a signed stream write needs a contentLength");
      }
      const response = await request(urlFor(path), {
        method: "PUT",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
    },
    async writeIfAbsent(path, body, contentType) {
      // rclone serve s3 ignores If-None-Match on a PUT, so create-only is not enforced there.
      const response = await request(urlFor(path), {
        method: "PUT",
        headers: { "content-type": contentType, "if-none-match": "*" },
        body,
      });
      if (response.status === 412) {
        return false;
      }
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
      return true;
    },
    async remove(path, { ifMatch } = {}) {
      const headers = {};
      if (typeof ifMatch === "string" && ifMatch !== "") {
        headers["if-match"] = quotedEntityTag(ifMatch);
      }
      const response = await request(urlFor(path), { method: "DELETE", headers });
      if (response.status === 412) {
        throw new ChangedUnderUsError(path);
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage delete failed with ${response.status}`);
      }
    },
    async listKeys(path, options = {}) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const { startAfter, limit } = options;
      const keys = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null && startAfter !== undefined
            ? `&start-after=${encodeURIComponent(startAfter)}`
            : "") +
          (limit === undefined ? "" : `&max-keys=${limit}`) +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = decodeEntities(tagValue(match[1], "Key"));
          if (key !== "") {
            keys.push(key);
          }
        }
        if (limit !== undefined && keys.length >= limit) {
          return keys.slice(0, limit);
        }
        token = nextContinuationToken(xml);
        if (token === null) {
          return keys;
        }
        if (token === seen) {
          throw new Error(
            "storage list repeated continuation-token; the listing is not fully read",
          );
        }
        seen = token;
      }
    },
    /**
     * One DeleteObjects call for up to 1,000 keys — S3's own per-call
     * ceiling, and the whole point for the nightly purge (drive#565): a
     * 100,000-file account is 100 calls instead of 100,000, ten times under
     * the run's subrequest budget instead of ten times over. The answer is
     * checked per key, because DeleteObjects answers 200 with an <Error>
     * block for every key the provider refused.
     * @param {string[]} paths
     */
    async removeBatch(paths) {
      if (paths.length > REMOVE_BATCH_LIMIT) {
        throw new Error(
          `removeBatch takes at most ${REMOVE_BATCH_LIMIT} keys, got ${paths.length}`,
        );
      }
      if (paths.length === 0) {
        return;
      }
      const firstBucket = bucketOf(paths[0]);
      for (const path of paths) {
        if (bucketOf(path) !== firstBucket) {
          throw new Error("removeBatch takes keys from one bucket");
        }
      }
      const body =
        "<Delete>" +
        paths.map((path) => `<Object><Key>${escapeXmlText(path)}</Key></Object>`).join("") +
        "</Delete>";
      const response = await request(`${baseFor(paths[0])}/?delete`, {
        method: "POST",
        headers: { "content-type": "application/xml", "content-md5": await contentMd5(body) },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage batch delete failed with ${response.status}`);
      }
      const xml = await response.text();
      const refused = [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)];
      if (refused.length > 0) {
        const index = paths.indexOf(decodeEntities(tagValue(refused[0][1], "Key")));
        const code = tagValue(refused[0][1], "Code");
        throw new Error(
          `storage batch delete refused ${refused.length} of ${paths.length} keys (first at index ${index}) with ${code || "an error"}`,
        );
      }
    },
    /**
     * The copy `drive branch` makes (build step 7). A file at or under S3's
     * single-copy ceiling is one CopyObject; a larger file is a multipart copy,
     * because CopyObject copies at most 5 GiB per call and a bigger source is
     * the refusal S3 answers instead of the copy. `size` is the byte length
     * the caller's listing already carried, so the copy S3 needs for those
     * bytes is chosen without a second request per file.
     * `options.ifAbsent` HEADs the destination first and throws
     * `ChangedUnderUsError` when anything is there (drive issue #605).
     * @param {string} from
     * @param {string} to
     * @param {number} [size]
     * @param {{ifAbsent?: boolean, versionId?: string}} [options]
     */
    async copy(from, to, size, options = {}) {
      if (options.ifAbsent) await assertDestinationEmpty(request, urlFor, to);
      const versioned = options.versionId
        ? `?versionId=${encodeURIComponent(options.versionId)}`
        : "";
      const source = `/${bucketOf(from)}/${from.split("/").map(encodeURIComponent).join("/")}${versioned}`;
      if (typeof size === "number" && size > SINGLE_COPY_LIMIT) {
        return multipartCopy(request, urlFor, source, to, size, options);
      }
      const response = await request(urlFor(to), {
        method: "PUT",
        headers: { "x-amz-copy-source": source },
      });
      const body = await response.text();
      const code = tagValue(body, "Code");
      if (response.ok && code === "" && body.includes("<CopyObjectResult")) {
        return bareEtag(body);
      }
      const oversize =
        code === "EntityTooLarge" ||
        (code === "InvalidRequest" &&
          /larger than the maximum|too large/i.test(tagValue(body, "Message")));
      if (oversize) {
        const size = await sourceSize(request, urlFor, from);
        return multipartCopy(request, urlFor, source, to, size, options);
      }
      if (!response.ok) {
        throw new Error(`storage copy failed with ${response.status}`);
      }
      if (code !== "") {
        throw new Error(`storage copy was refused: ${code}`);
      }
      throw new Error(
        "storage copy did not answer with a CopyObjectResult; the copy may still be running",
      );
    },
    /**
     * Every version of every file under one drive path, from S3's own
     * ListObjectVersions (the stock API for a versioned bucket: iDrive e2 and
     * B2 both speak it). The live ListObjectsV2 walk above cannot see a hidden
     * version, and a hidden version's stop time is what the meter bills to, so
     * the reconciler reads this instead.
     *
     * The provider's spelling of the lifecycle is this method's to know: S3
     * reports every version of a key newest first and marks it hidden at the
     * instant the next version of the same key began, which is exactly the
     * `created_at` -> `hidden_at` interval the meter bills. A delete marker is
     * the hide that ended the key's latest version. B2's ListFileVersions
     * returns the same facts under its own tags; the real provider's field
     * names are #60's to confirm (build-spec.md, open questions).
     * @param {string} path
     * @param {{exact?: boolean}} [options] `exact` lists the versions of the one file at `path`, not the folder under it
     * @returns {Promise<import("./files-scope.js").StorageVersion[]>}
     */
    async listVersions(path, options = {}) {
      const prefix = options.exact || path.endsWith("/") ? path : `${path}/`;
      const versions = [];
      /** @type {Array<{path: string, at: number}>} */
      const markers = [];
      let keyMarker = null;
      let versionMarker = null;
      let seen = null;
      for (;;) {
        const query =
          `?versions&prefix=${encodeURIComponent(prefix)}` +
          (keyMarker === null ? "" : `&key-marker=${encodeURIComponent(keyMarker)}`) +
          (versionMarker === null ? "" : `&version-id-marker=${encodeURIComponent(versionMarker)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage version list failed with ${response.status}`);
        }
        const xml = await response.text();
        versions.push(...parseListVersions(xml));
        markers.push(...versionMarkers(xml));
        const next = nextVersionMarkers(xml);
        keyMarker = next.keyMarker;
        versionMarker = next.versionMarker;
        if (keyMarker === "" || versionMarker === "") {
          return computeHiddenAt(versions, markers);
        }
        if (`${keyMarker}\u0000${versionMarker}` === seen) {
          throw new Error(
            `storage version list repeated markers for ${prefix}; the history is not fully listed`,
          );
        }
        seen = `${keyMarker}\u0000${versionMarker}`;
      }
    },
  };
}

/**
 * S3 answers a ListObjectsV2 as XML; this turns the two shapes the page needs
 * (`<CommonPrefixes>` folders and `<Contents>` files) into rows. Kept small and
 * separate so the test can feed it a real `rclone serve s3` response.
 * @param {string} xml
 * @param {string} prefix the storage prefix the listing was for
 * @param {string} path the drive path the listing was for
 * @param {{deep?: boolean}} [options] `deep` keeps keys that carry a slash:
 *   the delimiter-less walk (`listAll`, drive#570) returns nested keys, and
 *   the flat listing they would corrupt is the one call that must not see them.
 * @returns {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>}
 */
export function parseListObjects(xml, prefix, path, options = {}) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListObjects needs the XML body");
  }
  /** @type {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>} */
  const entries = [];
  const common = /<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g;
  for (const match of xml.matchAll(common)) {
    const name = decodeEntities(match[1]).slice(prefix.length).replace(/\/$/, "");
    if (name) {
      entries.push({ name, path: `${path === "/" ? "" : path}/${name}`, kind: "folder" });
    }
  }
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const name = decodeEntities(tagValue(block, "Key")).slice(prefix.length);
    if (!name || (name.includes("/") && !options.deep)) {
      continue;
    }
    entries.push({
      name,
      path: `${path === "/" ? "" : path}/${name}`,
      kind: fileKind(name),
      size: Number(tagValue(block, "Size") || 0),
      modified: Date.parse(tagValue(block, "LastModified")) || null,
      etag: (tagValue(block, "ETag") || "").replace(/"/g, ""),
    });
  }
  return entries;
}

/**
 * Text for inside one XML element, with the characters XML reserves escaped.
 * A storage key can carry `<` or `&` (validatePath allows both), and a Delete
 * body that sends them raw is a parse error on the provider side.
 * @param {string} text
 * @returns {string}
 */
function escapeXmlText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The rows the file list renders: folders first, then files. A row carries
 * only the instant an entry was written and no clock of its own: the browser
 * writes the words, because a UTC row follows every customer west of
 * Greenwich around the map (drive#559).
 * @param {FileEntry[]} entries
 */
export function fileRows(entries) {
  const { folders, files } = splitEntries(entries);
  /** @param {{name: string, path?: string, kind?: string, size?: number, modified?: number|null, contentType?: string}} entry */
  const row = (entry) => {
    const folder = entry.kind === "folder";
    return {
      name: entry.name,
      path: entry.path || "",
      kind: folder ? "folder" : entry.kind || fileKind(entry.name, entry.contentType),
      sizeLabel: folder ? "" : formatBytes(entry.size || 0),
      modifiedIso: entry.modified ? isoStamp(entry.modified, `the file ${entry.name}`) : "",
    };
  };
  return [...folders.map(row), ...files.map(row)];
}

/**
 * The rows Recently deleted renders, newest first. The two dates are instants
 * for the browser to write in its own zone: the delete time and the day the
 * window closes are both UTC words if this Worker writes them (drive#559).
 * @param {FileEntry[]} entries
 * @param {number} [now]
 * @param {number} [days] the account's window
 */
export function trashRows(entries, now = Date.now(), days = RECENTLY_DELETED_DAYS) {
  return entries
    .map((entry) => {
      const parsed = parseTrashName(entry.name);
      if (!parsed) {
        return null;
      }
      const restorable = isRestorable(parsed.deletedAt, now, days);
      return {
        name: parsed.path.split("/").pop() || "",
        path: parsed.path,
        deletedAt: parsed.deletedAt,
        sizeLabel: formatBytes(entry.size || 0),
        deletedIso: isoStamp(parsed.deletedAt, `the file ${parsed.path}`),
        untilIso: isoStamp(parsed.deletedAt + days * DAY_MS, `the file ${parsed.path}`),
        restorable,
        restoreLabel: restorable ? "Restore" : `Past the ${days} days`,
        goneLabel: restorable
          ? ""
          : `This one has been gone ${days} days. Restoring it is not possible.`,
      };
    })
    .filter(Boolean)
    .sort(
      /**
       * `filter(Boolean)` above is the guard for null rows; the cast is that
       * same guard at the sort's own types, not a new default.
       * @param {{deletedAt: number}|null} a
       * @param {{deletedAt: number}|null} b
       * @returns {number}
       */
      (a, b) =>
        /** @type {{deletedAt: number}} */ (b).deletedAt -
        /** @type {{deletedAt: number}} */ (a).deletedAt,
    );
}

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
export function plain(message, status) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
