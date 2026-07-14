// Cross-language JWT check. Usage: node xcheck.ts <token> <secret>
// Verifies a token (signed by shared-py) using shared-ts, and round-trips one back.
import { sign, verify } from "./jwt.ts";

const [token, secret] = process.argv.slice(2);

// 1. Verify the Python-signed token in TypeScript.
const claims = verify(token, secret, { now: 1000 });
console.log("TS verified py-token:", JSON.stringify(claims));

// 2. Sign a token in TS and print it so Python can verify it back.
const tsToken = sign({ sub: "usr_ts", role: "power_user" }, secret);
console.log("TS_TOKEN=" + tsToken);
