import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, ipInCidr, needsAcknowledgement, normalizeCidr, policyApplies, totpCode, validIdleHours, verifyTotp, viewerMayExport, discoveryHourKey, POLICY_YEAR_MS } from "./governance";

describe("governance helpers", () => {
  it("TOTP matches RFC 6238's SHA-1 vectors (6 digits)", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(await totpCode(secret, Math.floor(2000000000 / 30))).toBe("279037");
    const step = await verifyTotp(secret, "081804", 1111111109_000);
    expect(step).toBe(Math.floor(1111111109 / 30));
    expect(await verifyTotp(secret, "081804", 1111111109_000, step!)).toBeNull(); // no replay
  });
  it("base32 round-trips", () => {
    const b = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("1")).toBeNull();
  });
  it("normalizes CIDRs and matches addresses", () => {
    expect(normalizeCidr("10.1.2.3/8")).toBe("10.0.0.0/8");
    expect(normalizeCidr("1.2.3.4")).toBe("1.2.3.4/32");
    expect(normalizeCidr("2001:DB8:0:0::1/32")).toBe("2001:db8::/32");
    expect(normalizeCidr("::ffff:1.2.3.4")).toBe("::ffff:102:304/128");
    expect(normalizeCidr("10.0.0.0/8", "network")).toBeNull();
    expect(normalizeCidr("2001::/16", "network")).toBeNull();
    expect(normalizeCidr("256.1.1.1")).toBeNull();
    expect(normalizeCidr("1.2.3.4/33")).toBeNull();
    expect(ipInCidr("10.200.1.1", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("::ffff:10.0.0.1", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("2001:db8:1::5", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::5", "2001:db8::/32")).toBe(false);
  });
  it("idle hours, exporting, policies, hour keys", () => {
    expect(validIdleHours(0.25, true)).toBe(true);
    expect(validIdleHours(0.3, true)).toBe(false);
    expect(validIdleHours(0.25, false)).toBe(false);
    expect(validIdleHours(12, false)).toBe(true);
    expect(viewerMayExport({ fileExporting: "guests_blocked" }, true)).toBe(true);
    expect(viewerMayExport({ fileExporting: "guests_blocked" }, false)).toBe(false);
    expect(viewerMayExport({ fileExporting: "viewers_blocked" }, true)).toBe(false);
    expect(policyApplies({ audience: "guests" }, "member")).toBe(false);
    expect(policyApplies({ audience: "members" }, "admin")).toBe(true);
    expect(needsAcknowledgement({ cadence: "once" }, 1, 1 + 2 * POLICY_YEAR_MS)).toBe(false);
    expect(needsAcknowledgement({ cadence: "yearly" }, 1, 1 + POLICY_YEAR_MS)).toBe(true);
    expect(discoveryHourKey(Date.UTC(2026, 9, 12, 7, 59))).toBe("2026/10/12/07");
  });
});
