import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BOOTSTRAP_ENV, childBootstrap, decodeBootstrap, encodeBootstrap, parseBootstrap, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

const wire = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const unpack = raw => JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
const fixture = () => childBootstrap(rootOrientation(randomUUID()), target(), true, "review", "Review 'auth' · 日本語 $HOME");
const compact = seed => [2, seed.taskId, seed.conversationId, seed.role, seed.topic, seed.origin ? [
 seed.origin.taskId === seed.taskId ? null : seed.origin.taskId,
 seed.origin.conversationId, seed.origin.role, seed.origin.sessionId,
 [seed.origin.target.windowId, seed.origin.target.workspaceId, seed.origin.target.paneId, seed.origin.target.surfaceId],
] : null];

for (const role of ["main", "chat", "review", "continue"]) for (const related of [true, false]) {
 test(`compact bootstrap preserves all identities: role=${role}, related=${related}`, () => {
  const seed = childBootstrap(rootOrientation(randomUUID()), target(), related, role, "Review 'auth' · 日本語 $HOME");
  const encoded = encodeBootstrap(seed), value = unpack(encoded);
  assert.deepEqual(value, compact(seed));
  assert.deepEqual(decodeBootstrap(encoded), seed);
  assert.deepEqual(decodeBootstrap(wire(seed)), seed, "legacy v1 object remains readable");
  assert.equal(value[5][0], related ? null : seed.origin.taskId, "only an equal task UUID may be omitted");
  assert.ok(Buffer.byteLength(encoded) <= Buffer.byteLength(wire(seed)) * 0.8, "save at least 20% for a tracked launch");
 });
}

test("compact root and opaque parent session IDs retain the v1 in-memory schema", () => {
 const { sessionId, ...root } = rootOrientation("opaque-session");
 assert.deepEqual(unpack(encodeBootstrap(root)), compact(root));
 assert.deepEqual(decodeBootstrap(encodeBootstrap(root)), root);
 assert.deepEqual(decodeBootstrap(wire(root)), root);
 const seed = childBootstrap(rootOrientation("opaque/session-" + "x".repeat(100)), target(), true, "chat", "");
 assert.deepEqual(decodeBootstrap(encodeBootstrap(seed)), seed);
 assert.equal(decodeBootstrap(encodeBootstrap(seed)).version, 1);
});

test("compact bootstrap retains an immediate reviewer origin, not the task root", () => {
 const parent = { ...fixture(), sessionId: randomUUID() };
 const next = childBootstrap(parent, target(), true, "review", "Review reviewer");
 const decoded = decodeBootstrap(encodeBootstrap(next));
 assert.deepEqual(decoded, next);
 assert.equal(decoded.origin.sessionId, parent.sessionId);
 assert.equal(decoded.origin.conversationId, parent.conversationId);
});

test("compact encoder validates and normalizes through the existing schema", () => {
 const seed = fixture();
 const input = { ...seed, taskId: seed.taskId.toUpperCase(), topic: "  Review\n\t日本語  " };
 assert.deepEqual(decodeBootstrap(encodeBootstrap(input)), parseBootstrap(input));
 for (const bad of [{ ...seed, version: 2 }, { ...seed, taskId: "surface:1" }, { ...seed, role: ["review"] }, { ...seed, topic: "x".repeat(301) }, { ...seed, origin: { ...seed.origin, sessionId: "" } }, { ...seed, origin: { ...seed.origin, role: ["main"] } }]) {
  assert.throws(() => encodeBootstrap(bad), /Invalid cmux orientation bootstrap/);
 }
});

test("compact decoder rejects malformed tuples without guessing an identity or target", () => {
 const valid = compact(fixture());
 const mutations = [
  v => { v[0] = 3; }, v => { v[0] = "2"; }, v => v.pop(), v => v.push("extra"),
  v => { v[1] = null; }, v => { v[2] = "surface:1"; }, v => { v[3] = "worker"; }, v => { v[3] = ["review"]; },
  v => { v[4] = "x".repeat(301); }, v => { v[4] = {}; }, v => { v[5] = {}; }, v => { v[5] = false; },
  v => v[5].pop(), v => v[5].push("extra"), v => { v[5][0] = ""; }, v => { v[5][1] = "surface:1"; },
  v => { v[5][2] = "worker"; }, v => { v[5][2] = ["main"]; }, v => { v[5][3] = ""; }, v => { v[5][3] = "x".repeat(129); },
  v => { v[5][4] = {}; }, v => v[5][4].pop(), v => v[5][4].push(randomUUID()),
  ...[0, 1, 2, 3].map(i => v => { v[5][4][i] = "surface:1"; }),
 ];
 for (const mutate of mutations) {
  const value = structuredClone(valid); mutate(value);
  assert.throws(() => decodeBootstrap(wire(value)), /Invalid cmux orientation bootstrap/, JSON.stringify(value));
 }
 for (const value of [null, [], {}, { ...fixture(), version: 2 }, [1, ...valid.slice(1)]]) {
  assert.throws(() => decodeBootstrap(wire(value)), /Invalid cmux orientation bootstrap/);
 }
 for (const raw of ["", "bad!", "x".repeat(8193), Buffer.from("not json").toString("base64url")]) {
  assert.throws(() => decodeBootstrap(raw), /Invalid cmux orientation bootstrap/);
 }
});

for (const format of ["legacy", "compact"]) test(`${format} startup consumes bootstrap once and persists only the existing schema`, async t => {
 const seed = fixture(), h = orientationHarness(t, { bootstrap: format === "legacy" ? wire(seed) : wire(compact(seed)) });
 await h.emit("session_start");
 assert.deepEqual(h.runtime.state, { ...seed, sessionId: h.ctx.sessionManager.getSessionId() });
 assert.equal(process.env[BOOTSTRAP_ENV], undefined);
 const saved = h.runtime.state;
 await h.emit("session_start");
 assert.deepEqual(h.runtime.state, saved);
});

test("invalid compact startup disables orientation before native inspection", async t => {
 const value = compact(fixture()); value[5][4][3] = "surface:1";
 const h = orientationHarness(t, { bootstrap: wire(value) });
 await h.emit("session_start");
 assert.equal(h.runtime.state, undefined);
 assert.equal(process.env[BOOTSTRAP_ENV], undefined);
 assert.equal(h.calls.length, 0);
 assert.match(h.notifications.at(-1)[0], /Invalid cmux orientation bootstrap/);
});
