// Live trust-policy check. Source hosts: https://emudhra.we-have-a-problem.com/
// DNS errors, timeouts, and unrelated certificate errors are failures, not proof.
import https from "node:https";
const hosts = [
  "dv-g3b",
  "dv-g3c",
  "ov-g3b",
  "ov-g3c",
  "ev-g3b",
  "ev-g3c",
].flatMap((id) => [
  id + "-emudhra.we-have-a-problem.com",
  id + "-aaa-emudhra.we-have-a-problem.com",
]);
const trustErrors = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_REVOKED",
  "UNABLE_TO_GET_ISSUER_CERT",
]);
let failures = 0;
for (const api of ["fetch", "https"]) {
  for (const host of ["registry.npmjs.org", ...hosts]) {
    const negative = host !== "registry.npmjs.org";
    try {
      if (api === "fetch") {
        const r = await fetch("https://" + host + "/", {
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        await r.body?.cancel();
      } else
        await new Promise((resolve, reject) => {
          const r = https.get(
            "https://" + host + "/",
            { signal: AbortSignal.timeout(15000) },
            (res) => {
              res.resume();
              resolve();
            },
          );
          r.on("error", reject);
        });
      console.log(
        api,
        host,
        negative ? "FAIL trusted compromised chain" : "PASS valid chain",
      );
      if (negative) failures++;
    } catch (e) {
      const code = e.cause?.code ?? e.code;
      const pass = negative && trustErrors.has(code);
      console.log(
        api,
        host,
        pass ? "PASS rejected " + code : "FAIL " + code + " " + e.message,
      );
      if (!pass) failures++;
    }
  }
}
process.exitCode = failures ? 1 : 0;
