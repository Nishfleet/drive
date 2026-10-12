// Split out of core/files-p4.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { ChangedUnderUsError } from "./files-scope.js";
import { decodeEntities, tagValue } from "./s3-listing.js";

/**
 * S3's single-copy ceiling. CopyObject copies at most 5 GiB per call (Amazon
 * S3, "Copying objects"; iDrive e2 and B2 publish the same limit), so a bigger
 * source is only copyable the multipart way: CreateMultipartUpload, one
 * UploadPartCopy per byte range, then CompleteMultipartUpload. In GiB, because
 * 5 GiB is the number S3 documents and every implementation measures against.
 */
export const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;
/** The most keys one DeleteObjects call may name: S3's own ceiling. */
export const REMOVE_BATCH_LIMIT = 1000;
/** The byte range one UploadPartCopy copies. S3's floor for a copy part is
 * 5 MiB; 16 MiB puts a 10 GB branch file at 640 requests and a 6 GB one at 384,
 * which is a request count a stand-in and a real provider both answer quickly.
 */
const COPY_PART_SIZE = 16 * 1024 ** 2;
/** S3's cap on the parts in one multipart upload. A range narrower than
 * COPY_PART_SIZE for an object this large is only needed past 160 GiB, so the
 * cap is checked rather than assumed.
 */
const COPY_MAX_PARTS = 10000;

/**
 * One S3 multipart copy: CreateMultipartUpload, an UploadPartCopy for every
 * byte range of the source, then CompleteMultipartUpload with the ETag each
 * part answered. No bytes pass through here either — every call is the storage
 * copying inside itself, which is the whole point of a branch copy (build step
 * 7): a 10 GB branch must not be 10 GB through the Worker.
 *
 * Every answer is read, not trusted on its status: S3 answers 200 with an
 * `<Error>` body for a refused part and 200 with nothing at all for a part it
 * accepted but did not copy, and a copy reported as done without the object
 * behind it is the one failure a branch must never report as success.
 *
 * A failure after the upload started aborts it (`DELETE ?uploadId=`), because
 * parts of an unfinished multipart upload are still billed by every S3-shaped
 * provider, and a branch that failed must not leave a bill behind it.
 *
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl the store's one request path, signing when
 * the store holds a credential
 * @param {(path: string) => string} urlFor
 * @param {string} source the `x-amz-copy-source` header value, `/<bucket>/<key>`
 * @param {string} to the destination storage key
 * @param {number} size the source's byte length, from the listing or a HEAD
 * @param {{ifAbsent?: boolean}} [options] `copy`'s guard, read again before the
 *   completion because a multipart copy is many requests wide (issue #605)
 * @returns {Promise<string|undefined>} the new object's ETag
 */
export async function multipartCopy(fetchImpl, urlFor, source, to, size, options = {}) {
  const partSize = Math.max(COPY_PART_SIZE, Math.ceil(size / COPY_MAX_PARTS));
  const target = urlFor(to);
  const created = await fetchImpl(`${target}?uploads`, { method: "POST" });
  const createdBody = await created.text();
  if (!created.ok || createdBody.includes("<Error>")) {
    throw new Error(`storage multipart copy could not start: ${copyFailure(created, createdBody)}`);
  }
  const uploadId = tagValue(createdBody, "UploadId");
  if (uploadId === "") {
    throw new Error("storage multipart copy started without an upload id");
  }
  const upload = `uploadId=${encodeURIComponent(uploadId)}`;
  try {
    /** @type {string[]} one <Part> per range, in order, for the completion */
    const parts = [];
    for (let start = 0, number = 1; start < size; start += partSize, number += 1) {
      const end = Math.min(start + partSize, size) - 1;
      const copied = await fetchImpl(`${target}?partNumber=${number}&${upload}`, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": source,
          "x-amz-copy-source-range": `bytes=${start}-${end}`,
        },
      });
      const copiedBody = await copied.text();
      if (!copied.ok || copiedBody.includes("<Error>")) {
        throw new Error(
          `storage multipart copy part ${number} failed: ${copyFailure(copied, copiedBody)}`,
        );
      }
      // The ETag is S3's, XML-escaped in the part's answer and read back into
      // the completion as it was answered, so the entity the server sent is the
      // entity the server gets. A part with no ETag cannot be named in the
      // completion, and a completion without it cannot be finished: naming
      // that beats completing an upload of nothing.
      const etag = tagValue(copiedBody, "ETag");
      if (etag === "" || !copiedBody.includes("<CopyPartResult")) {
        throw new Error(
          `storage multipart copy part ${number} came back without a CopyPartResult ETag; the copy cannot be completed`,
        );
      }
      parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`);
    }
    if (options.ifAbsent) await assertDestinationEmpty(fetchImpl, urlFor, to);
    const completed = await fetchImpl(`${target}?${upload}`, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
    });
    const completedBody = await completed.text();
    if (!completed.ok || completedBody.includes("<Error>")) {
      throw new Error(
        `storage multipart copy could not be completed: ${copyFailure(completed, completedBody)}`,
      );
    }
    if (!completedBody.includes("<CompleteMultipartUploadResult")) {
      throw new Error(
        "storage multipart copy did not answer with a CompleteMultipartUploadResult; the object may not be whole",
      );
    }
    return bareEtag(completedBody);
  } catch (error) {
    // The parts uploaded so far are still stored and billed until the upload is
    // aborted, so the abort is part of failing the copy. A failed abort is
    // logged and the copy's own error is what the caller is told — the copy
    // failed either way, and the upload id is in the line so it can be aborted
    // by hand.
    const aborted = await fetchImpl(`${target}?${upload}`, { method: "DELETE" }).catch(
      (abortError) => {
        console.error?.(
          `storage multipart copy abort failed for ${to} (${upload}): ${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
        return null;
      },
    );
    if (aborted !== null && !aborted.ok) {
      console.error?.(
        `storage multipart copy abort for ${to} (${upload}) answered ${aborted.status}; the uploaded parts are still billed`,
      );
    }
    throw error;
  }
}

/**
 * The ETag in a copy answer, unquoted the way `parseListObjects` unquotes it,
 * or `undefined` when the answer carries none.
 * @param {string} body
 * @returns {string|undefined}
 */
export function bareEtag(body) {
  return decodeEntities(tagValue(body, "ETag")).replace(/"/g, "") || undefined;
}

/**
 * The one place a copy-shaped S3 answer becomes a sentence: a status that is
 * not 2xx, an `<Error>` body, or neither a result nor an error (the copy that
 * has not happened yet). `null` is the only answer that means the call did what
 * it was asked.
 * @param {Response} response
 * @param {string} body
 * @returns {string|null}
 */
function copyFailure(response, body) {
  const code = tagValue(body, "Code");
  if (!response.ok) {
    return `the storage answered ${response.status}${code === "" ? "" : ` with ${code}`}`;
  }
  if (code !== "") {
    return `the storage refused the copy: ${code}`;
  }
  return "the storage answered neither a result nor an error";
}

/**
 * A source object's byte length, from the one call S3 answers it with. A size
 * that cannot be read is a named failure, not a zero: a multipart copy with no
 * ranges would upload no parts and report a copy that never moved a byte.
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(path: string) => string} urlFor
 * @param {string} from
 * @returns {Promise<number>}
 */
export async function sourceSize(fetchImpl, urlFor, from) {
  const response = await fetchImpl(urlFor(from), { method: "HEAD" });
  const length = Number(response.headers.get("content-length") || 0);
  if (!response.ok || !(length > 0)) {
    throw new Error(
      `storage copy could not read the size of ${from} (HEAD answered ${response.status}), so the copy over the single-copy limit cannot be made`,
    );
  }
  return length;
}

/**
 * Throw `ChangedUnderUsError` when the copy's destination holds an object. One
 * HEAD. A 404 is empty. Any other failure is thrown, not read as empty, so a
 * permission error never turns into a copy over bytes the store could not read
 * (drive issue #605).
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(path: string) => string} urlFor
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function assertDestinationEmpty(fetchImpl, urlFor, to) {
  const response = await fetchImpl(urlFor(to), { method: "HEAD" });
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(
      `storage could not read ${to} before the copy (HEAD answered ${response.status})`,
    );
  }
  throw new ChangedUnderUsError(to);
}
