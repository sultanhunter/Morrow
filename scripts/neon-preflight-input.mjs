import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const fail = () => {
  throw Error("NEON_PREFLIGHT_INPUT_DENIED");
};

// Private operator input, never a merchant request or a provisioning receipt.
export function parseNeonPreflightInput(input) {
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "branchId,database,environment,hostname,ownerPassword,ownerUser,projectId"
  )
    fail();
  if (
    input.environment !== "staging" ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.projectId ?? "") ||
    !/^br-[a-z0-9-]{1,77}$/.test(input.branchId ?? "") ||
    !/^ep-[a-z0-9-]+\.(?:c-[0-9]+\.)?[a-z0-9-]+\.(aws|azure)\.neon\.tech$/.test(
      input.hostname ?? "",
    ) ||
    input.database !== "morrow_staging" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(input.ownerUser ?? "") ||
    typeof input.ownerPassword !== "string" ||
    input.ownerPassword.length < 16 ||
    input.ownerPassword.length > 1024 ||
    /[\x00-\x20\x7f]/.test(input.ownerPassword)
  )
    fail();
  if (Object.values(input).some((value) => typeof value !== "string")) fail();
  return Object.freeze({ ...input });
}

export function loadNeonPreflightInput(path, privateRoot) {
  try {
    const root = resolve(privateRoot),
      file = resolve(path);
    const folder = lstatSync(root),
      stat = lstatSync(file);
    if (
      folder.isSymbolicLink() ||
      !folder.isDirectory() ||
      (folder.mode & 0o777) !== 0o700 ||
      !file.startsWith(root + sep) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      realpathSync(file) !== resolve(realpathSync(root), relative(root, file)) ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192 ||
      folder.uid !== process.getuid() ||
      stat.uid !== process.getuid()
    )
      fail();
    return parseNeonPreflightInput(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    fail();
  }
}

export function publicNeonPreflightBinding(input) {
  const { environment, projectId, branchId, hostname, database } = input;
  return { environment, projectId, branchId, hostname, database };
}
