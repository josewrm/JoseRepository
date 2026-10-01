import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase } from "../store/db.ts";
import { RecordStore } from "../store/record-store.ts";
import { Apply2InterviewService } from "../app/service.ts";
import { createAppServer } from "./http.ts";
import { validatePack } from "../../scripts/validate-export.ts";

const root = resolve(import.meta.dirname, "../..");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const token = process.env.A2I_HOST_TOKEN ?? randomBytes(24).toString("hex");
const dbPath = process.env.A2I_DB ?? resolve(root, "data/apply2interview.sqlite");

const db = openDatabase(dbPath);
const store = new RecordStore(db, { authorize: (auth) => auth === `HostAuth ${token}` });
const service = new Apply2InterviewService(store, { authorization: `HostAuth ${token}` });
service.ensureParticipants();

const server = createAppServer({
  service,
  token,
  exportDir: resolve(root, "exports"),
  outcomeDir: resolve(root, "outcome-reports"),
  validatePack: (dir) => {
    try {
      return validatePack(dir);
    } catch (error) {
      return [{ command: "jarvis cli", file: dir, ok: false, output: (error as Error).message }];
    }
  },
});

server.listen(port, host, () => {
  console.log(`Apply2Interview host on http://${host}:${port}`);
  console.log(`Records: ${dbPath}`);
});
