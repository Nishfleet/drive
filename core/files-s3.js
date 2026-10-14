// Split out of core/files-memory.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
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
  // One ceiling for every storage call this store makes: a stalled socket
  // answers named instead of holding a customer's page open forever
  // (drive#570). Configurable because a test proves the abort in milliseconds.
  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : FETCH_TIMEOUT_MS;
  if (!endpoint || (!bucket && typeof bucketFor !== "function")) {
    throw new Error("createS3Store needs an endpoint and a bucket.");
  }
  // One signer for the store, so every method below signs the same way and a
  // half-signed store is not a shape this can be in. A credential without a
  // region cannot be signed (the region is in the signature's scope), so that
  // pair is refused here rather than answering with a SignatureDoesNotMatch
  // the caller has to decode.
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
        // No retry inside the signer, the same setting the api Worker's client
        // uses (core/s3.js): a retry that succeeds after a real
        // refusal hides the refusal, and every caller above has its own named
        // failure for a non-ok answer.
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
      // `path` is a storage key (`u/<id>`, `u/<id>/Photos`); the query wants
      // exactly one trailing slash and no second one.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      // Every page, not the first. S3 caps one ListObjectsV2 answer at 1,000
      // keys and answers the rest through NextContinuationToken, so a single
      // call silently truncates a folder at 1,000 files: the Files page showed
      // the first thousand and the file index (issue #18) never indexed the
      // rest, which the stand-in proof caught on a 100,000-file drive (5,000 a
      // folder -> 20,000 of 100,000 indexed). The token is looped here, once,
      // so no caller has to remember to.
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          // A bucket that is not there yet is an empty drive, not a failure
          // (drive#540): a brand-new account's `drv-<id>` is created at its
          // sign-in verify (provisionAccountBucket), and an account from before
          // that existed — or on a deployment whose site Worker carries no
          // storage master credential — has no bucket until a key mint creates
          // one. S3 answers a missing bucket 404 and a missing folder 200 with
          // no keys, so a 404 here is always the bucket.
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        // The base a row's key is built from: the folder key without its
        // trailing slash, so a child key is `${base}/${name}`.
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1)));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          // A server answering the same token forever would spin here and hold
          // the request open. A truncated folder is the one failure this file
          // exists to prevent, so it is named instead of returned.
          throw new Error(
            "storage list repeated continuation-token; the folder is not fully listed",
          );
        }
        seen = token;
      }
    },
    async listPage(path, options = {}) {
      // ONE ListObjectsV2 call per page: `max-keys` caps the answer at what
      // the page asked for, and `continuation-token` is the store's cursor
      // passed through opaque (drive#570). The full walk `list` does is the
      // wrong tool for the Files page: a 2,500-file folder would cost three
      // storage calls and every key in the folder to show the first 200 rows.
      const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), 1_000);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const query =
        `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
        `&max-keys=${limit}` +
        (options.cursor ? `&continuation-token=${encodeURIComponent(options.cursor)}` : "");
      const response = await request(`${baseFor(prefix)}${query}`);
      if (response.status === 404) {
        // The missing bucket is an empty page, not a 500 (drive#540); the
        // long form is in `list` above.
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
      // The recursive walk: no delimiter, so every key under the prefix comes
      // back and the pages are looped here. This is the listing the Recently
      // deleted view reads now that a deleted file nests under
      // `.trash/<path>/<ts>` (drive#570) — `list`'s one-folder-deep answer
      // cannot see a nested key.
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
          // The missing bucket is an empty walk, not a 500 (drive#540); the
          // long form is in `list` above.
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
      // A HEAD, not a GET: the preview's HEAD answer needs the object's
      // headers and none of its bytes (drive#570). rclone serve s3 and the
      // providers behind it both answer HEAD the same way.
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
      // The client's Range and If-None-Match forwarded as the client sent
      // them: a seek reads its slice from storage (206), a still-valid etag
      // is refused by storage itself (304), and neither pulls the whole
      // object through this Worker just to drop most of it (drive#570).
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
      // On a 206 the Content-Length is the slice's length; the object's whole
      // size rides in `bytes s-e/total`, and `size` stays the whole size so a
      // caller can tell a slice from a short file without a second call.
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
        // The caller knows the size (the owner upload carries the browser's
        // Content-Length), so the body is sent as the stream it is and the
        // header rides along: the bytes are never read into isolate memory
        // (drive#539).
        headers["content-length"] = String(options.contentLength);
      } else if (aws !== null && body instanceof ReadableStream) {
        // A signed S3 PUT cannot carry a stream with no declared size: an
        // UNSIGNED-PAYLOAD upload with no aws-chunked framing has no length to
        // send, and an endpoint answers 411 Length Required (the MinIO stand-in
        // does, measured 2026-10-05). Buffering it here would put an unbounded
        // body into isolate memory, the exact failure drive#539 exists to
        // remove, so a caller that cannot declare a size is refused with a
        // clear error. The owner upload reads a length-less body under its own
        // ceiling and always passes a length.
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
      // The stock S3 create-only request: one PUT carrying If-None-Match: *,
      // which a compliant endpoint refuses with 412 Precondition Failed when
      // the key is already there. What THIS endpoint can honestly offer is
      // narrower than the contract's words, and it is measured, not assumed:
      //
      //   - `rclone serve s3` (v1.75.1, the stand-in on the build host)
      //     answered 200 to both the absent and the already-present PUT on
      //     2026-10-05 — it ignores If-None-Match on a PUT — so a `true`
      //     from that server is not a proof of create-only;
      //   - iDrive e2, the primary vendor, was never asked: its keys are
      //     Nish's alone, and the standing direction is to build without
      //     them. Its answer to the header is unverified.
      //
      // The header still rides every call, so on any endpoint that enforces
      // the conditional the race closes at the storage itself; where one does
      // not, this degrades to the overwrite `write` always was, and the
      // provider's hide-not-delete versioning stays the backstop that makes
      // an overwrite recoverable. A caller on such an endpoint pairs a
      // pre-check `stat` (the stranger-upload route does) so an ordinary
      // duplicate is still refused there; only a true mid-race pair is left to
      // this endpoint's own answer. A 412 is the only answer that proves the
      // key was already there, so it is the only false.
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
      // A conditional remove is the guard a delete needs. The ETag is what the
      // bytes were when the delete listed them, and a key whose bytes changed
      // since (a mount save that landed while the trash copy ran, drive issue
      // #567) is answered 412 rather than removed.
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
      // Flat: no delimiter, so hidden folders (`u/<id>/.trash`) come back
      // like any other key, which is what the purge needs. `start-after` is
      // S3's own resume parameter: the provider applies it before paging, so
      // it rides only the first request of the loop and the continuation
      // token walks the rest in the same order.
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
          // The same repeat guard the folder listing below carries: a server
          // answering the same token forever would hold the cron open.
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
      // DeleteObjects is one bucket's call: a batch that named two buckets
      // would silently miss the second's keys, so the mix is refused.
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
      // S3 refuses a Delete body without a Content-MD5, the same refusal the
      // lifecycle PUT answers, so the checksum goes with it (contentMd5, the
      // one MD5 the repo already carries).
      const response = await request(`${baseFor(paths[0])}/?delete`, {
        method: "POST",
        headers: { "content-type": "application/xml", "content-md5": await contentMd5(body) },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage batch delete failed with ${response.status}`);
      }
      const xml = await response.text();
      // The message names positions and the provider's code, never the key:
      // a key carries the person's file name, and the purge logs this text.
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
      // A hidden version is copied back by naming its id on the source, the
      // stock S3 way to restore an overwritten file.
      const versioned = options.versionId
        ? `?versionId=${encodeURIComponent(options.versionId)}`
        : "";
      const source = `/${bucketOf(from)}/${from.split("/").map(encodeURIComponent).join("/")}${versioned}`;
      if (typeof size === "number" && size > SINGLE_COPY_LIMIT) {
        return multipartCopy(request, urlFor, source, to, size, options);
      }
      // S3's CopyObject can answer 200 with an <Error> body for a refused copy
      // (a multi-part copy that is still running is the other 200), so the
      // answer is read and checked rather than trusted on its status alone:
      // `drive branch` must never report success for a copy S3 refused.
      // Proven against `rclone serve s3`, 2026-10-01.
      const response = await request(urlFor(to), {
        method: "PUT",
        headers: { "x-amz-copy-source": source },
      });
      const body = await response.text();
      const code = tagValue(body, "Code");
      if (response.ok && code === "" && body.includes("<CopyObjectResult")) {
        return bareEtag(body);
      }
      // A refusal that is the size limit is the one worth a second try: the
      // caller did not know the size (no listing carried it), so it asked S3
      // for a copy S3 will not make in one call. AWS answers that with
      // `InvalidRequest` naming the limit and B2 with `EntityTooLarge`; both
      // mean the multipart copy below is the copy that was asked for. Every
      // other refusal is reported as it is.
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
      // Every page, the same reason `list` loops: S3 caps one ListObjectVersions
      // answer at 1,000 keys and answers the rest through the two markers, so a
      // single call would truncate a large account's history.
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
        // Rows and delete markers are collected from every page and the stops
        // are computed once, here, over the whole list: a version's stop is the
        // next version of its own key, and that pair can sit on two different
        // pages, so a per-page pass would bill an old version as still live
        // (drive issue #504). The markers are decoded with the rows, so a key
        // that pages on through an escaped character comes back the way the
        // account wrote it.
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
    // S3 escapes the XML characters in every listing element, so a folder
    // named `a&b` is answered as `a&amp;b`; the folder this page shows is
    // the name the account wrote (drive issue #504).
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
      // S3's ETag is the content fingerprint a branch snapshot compares against
      // (build step 7): CopyObject preserves it, so a copied file matches and an
      // edited one does not. The quotes are S3's own and are stripped so two
      // stores' values compare in one form. A server that returns no ETag (the
      // spec allows it) gets the same empty value `tagValue` gives any missing
      // tag, and `fingerprint` turns that into null.
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
      // A folder has no write time, so it has no instant either. A file's
      // `modified` is optional in S3's own listing, so a server that reports
      // none is answering the spec and the row keeps its empty stamp; a
      // `modified` that is there but is not a date is a bug, and isoStamp
      // says so rather than rendering "Invalid Date" (drive#559).
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
        // A validated drive path always has a last segment; the `|| ""` is
        // here because split("").pop() is typed as possibly undefined and a
        // validated path cannot be empty.
        name: parsed.path.split("/").pop() || "",
        path: parsed.path,
        deletedAt: parsed.deletedAt,
        sizeLabel: formatBytes(entry.size || 0),
        deletedIso: isoStamp(parsed.deletedAt, `the file ${parsed.path}`),
        untilIso: isoStamp(parsed.deletedAt + days * DAY_MS, `the file ${parsed.path}`),
        restorable,
        // Past the window the button is gone, and the one line says why.
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

// ---------------------------------------------------------------- handlers

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
