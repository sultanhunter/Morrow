import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

// Resume only an existing private operator operation; never rotate credentials.
export function loadNeonAuthorityResume(path, privateRoot, operator, migrations) {
  try {
    const root = resolve(privateRoot),
      file = resolve(path);
    const folder = lstatSync(root),
      stat = lstatSync(file);
    if (
      folder.isSymbolicLink() ||
      !folder.isDirectory() ||
      (folder.mode & 0o777) !== 0o700 ||
      folder.uid !== process.getuid() ||
      !file.startsWith(root + sep) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid() ||
      stat.size > 200000 ||
      realpathSync(file) !== resolve(realpathSync(root), file.slice(root.length + 1))
    )
      throw Error();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const keys = [
      ...Object.keys(operator),
      "runtimePassword",
      "runId",
      "proofs",
      "migrations",
    ].sort();
    if (
      !saved ||
      Array.isArray(saved) ||
      Object.keys(saved).sort().join(",") !== keys.join(",") ||
      Object.entries(operator).some(([k, v]) => saved[k] !== v) ||
      typeof saved.runtimePassword !== "string" ||
      !/^[a-f0-9]{64}$/.test(saved.runtimePassword) ||
      typeof saved.runId !== "string" ||
      !/^qual_[a-f0-9]{24}$/.test(saved.runId) ||
      !Array.isArray(saved.proofs) ||
      saved.proofs.length !== 2 ||
      saved.proofs.some((p) => typeof p !== "string" || !/^[a-f0-9]{64}$/.test(p)) ||
      !Array.isArray(saved.migrations) ||
      saved.migrations.length !== 3 ||
      JSON.stringify(saved.migrations) !== JSON.stringify(migrations)
    )
      throw Error();
    return Object.freeze({
      ...saved,
      proofs: Object.freeze([...saved.proofs]),
      migrations: Object.freeze([...saved.migrations]),
    });
  } catch {
    throw Error("NEON_AUTHORITY_PRIVATE_OPERATION_DENIED");
  }
}
