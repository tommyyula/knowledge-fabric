import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileQueryAttachmentStager } from "../server/external/a2a-attachments";

const root = await mkdtemp(path.join(tmpdir(), "a2a-attachment-stager-"));
const stager = new FileQueryAttachmentStager(root);
const taskId = "11111111-1111-4111-8111-111111111111";

async function rejects(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

try {
  const bytes = Buffer.from("attachment seam");
  const receipts = await stager.stage(taskId, [{ raw: bytes.toString("base64"), filename: "note.bin", mediaType: "custom/example" }]);
  if (receipts.length !== 1 || receipts[0].name !== "note.bin" || receipts[0].size !== bytes.length || receipts[0].processed !== false || receipts[0].sha256.length !== 64) {
    throw new Error(`attachment staging did not return metadata-only receipts: ${JSON.stringify(receipts)}`);
  }
  if ((await readdir(path.join(root, taskId))).length !== 1) throw new Error("attachment staging did not isolate the Task file");
  await stager.cleanup(taskId);
  await rejects(() => access(path.join(root, taskId)), "attachment cleanup left the Task directory behind");

  const invalidTaskId = "22222222-2222-4222-8222-222222222222";
  await rejects(() => stager.stage(invalidTaskId, [
    { raw: Buffer.from("valid first file").toString("base64"), filename: "first.txt" },
    { raw: "", filename: "empty.txt" },
  ]), "attachment staging accepted an empty file");
  await rejects(() => access(path.join(root, invalidTaskId)), "atomic attachment validation left staged data after failure");
  await rejects(() => stager.stage("33333333-3333-4333-8333-333333333333", [{ raw: "YQ==", filename: "../escape.txt" }]), "attachment staging accepted an unsafe filename");
  await rejects(() => stager.stage("44444444-4444-4444-8444-444444444444", Array.from({ length: 11 }, (_, index) => ({ raw: "YQ==", filename: `${index}.txt` }))), "attachment staging accepted more than ten files");
  console.log("A2A attachment stager smoke ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
