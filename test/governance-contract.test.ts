// Conformance: Maintenance's enforcement against the shared governance contract's vectors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, CONTRACT, effectsOf, type Operation } from "../src/governance/rules.ts";
import { Principal, Role } from "../src/contracts.ts";

const vectors = JSON.parse(readFileSync(new URL("../contracts/governance/v1/vectors.json", import.meta.url), "utf8"));

test("vectors are for the contract version Maintenance enforces", () => {
  assert.equal(vectors.contract, CONTRACT.id);
  assert.equal(vectors.version, CONTRACT.version);
});

for (const c of vectors.cases) {
  test(`contract ${CONTRACT.version}: ${c.name}`, () => {
    const d = decide(c.operation as Operation, c.principal ? Principal.parse({ name: c.principal.id, ...c.principal }) : null, c.subject, c.digest);
    assert.equal(d.allow, c.expect.allow, JSON.stringify(d));
    if (!c.expect.allow) assert.ok((c.expect.codes ?? [c.expect.code]).includes((d as { code: string }).code), JSON.stringify(d));
    if (c.expect.result) assert.equal(d.result, c.expect.result, JSON.stringify(d));
  });
}

test("Maintenance's role names are exactly the contract's (no private roles)", () => {
  assert.deepEqual([...Role.options].sort(), Object.keys(CONTRACT.roles).sort());
});

test("the principal catalog refuses roles the contract does not allow for that principal type", () => {
  for (const [role, def] of Object.entries(CONTRACT.roles))
    for (const type of ["person", "agent", "component"]) {
      const ok = Principal.safeParse({ id: "x", name: "x", type, roles: [role] }).success;
      assert.equal(ok, def.principalTypes.includes(type), `${type} as ${role}`);
    }
  assert.deepEqual([...effectsOf({ type: "agent", roles: ["agent"] })].sort(), ["propose", "read", "withdraw"]);
});
