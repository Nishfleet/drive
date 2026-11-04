import { capStateForAccount } from "./cap-request.js";
import { createD1DeviceStore } from "./devices.js";
import { storageBucketForKey, storageVarsFromEnv } from "./files-memory.js";
import { createS3Store } from "./files-s3.js";
import { scopeStore, WRITE_GATE, WritesRefusedError } from "./files-scope.js";
import { prepaidPauseOn, writesPaused } from "./prepaid.js";

export const TEST_FILES_STORE = Symbol("drive.testFilesStore");

/** @type {import("./files.js").FileStore|undefined} */
let s3Store;
/** @type {WeakMap<object, {base: import("./files.js").FileStore, root: import("./files.js").FileStore}>} */
const roots = new WeakMap();
const missingLogged = new WeakSet();

/**
 * @param {Env} env
 * @returns {(accountId: string) => Promise<void>}
 */
function writeGate(env) {
  return async (accountId) => {
    const db = env.DRIVE_DB;
    if (!db) {
      return;
    }
    if ((await capStateForAccount(createD1DeviceStore(db), accountId)) !== "active") {
      throw new WritesRefusedError("cap-reached");
    }
    if (prepaidPauseOn(env) && (await writesPaused(db, accountId))) {
      throw new WritesRefusedError("paused");
    }
  };
}

/**
 * @param {Env} env
 * @returns {import("./files.js").FileStore | null}
 */
function s3StoreFor(env) {
  if (!s3Store) {
    const { endpoint, accessKeyId, secretAccessKey, region } = storageVarsFromEnv(
      /** @type {import("./files-memory.js").StorageEnv} */ (env),
    );
    if (!endpoint) {
      if (!missingLogged.has(env)) {
        missingLogged.add(env);
        console.error("files: no storage endpoint is set, so this deployment cannot serve files");
      }
      return null;
    }
    const signed =
      accessKeyId !== undefined && secretAccessKey !== undefined && region !== undefined;
    s3Store = createS3Store({
      endpoint,
      bucketFor: storageBucketForKey,
      ...(signed
        ? {
            region,
            credentials: {
              accessKeyId: /** @type {string} */ (accessKeyId),
              secretAccessKey: /** @type {string} */ (secretAccessKey),
            },
          }
        : {}),
    });
  }
  return s3Store;
}

/**
 * The storage every account's bytes live in, carrying this deployment's write
 * gate. Every scoped view of it refuses a write, copy or create for an account
 * at its cap or paused at $0, so a queue or cron that walks accounts gets the
 * refusal a route gets. Null when the deployment has no storage endpoint.
 * @param {Env} env
 * @returns {import("./files.js").FileStore | null}
 */
export function rootStoreFor(env) {
  const injected = /** @type {{[key: symbol]: import("./files.js").FileStore | undefined}} */ (env)[
    TEST_FILES_STORE
  ];
  const base = injected ?? s3StoreFor(env);
  if (!base) {
    return null;
  }
  const known = roots.get(env);
  if (known?.base === base) {
    return known.root;
  }
  const root = { ...base, [WRITE_GATE]: writeGate(env) };
  roots.set(env, { base, root });
  return root;
}

/**
 * The one way to get an account's store: scoped to the account's own prefix,
 * with the cap and pause checks on every write.
 * @param {Env} env
 * @param {{id: string, name?: string}} account
 * @returns {import("./files.js").FileStore | null}
 */
export function accountStore(env, account) {
  const root = rootStoreFor(env);
  return root ? scopeStore(root, account) : null;
}
