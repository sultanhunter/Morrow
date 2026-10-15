// Fixed synthetic checked-copy entrypoint; never the native operator.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWorkosAuthenticationOperator82Regression,
  workosAuthenticationRegressionFailure,
} from "./workos-authentication-operator-regression.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ outcome: "held", code: "INPUT_DENIED" }));
    process.exitCode = 1;
  } else {
    try {
      const report = await runWorkosAuthenticationOperator82Regression();
      console.log(
        JSON.stringify({
          status: report.status,
          tests: report.tests.length,
          checks: report.checks.length,
          realProviderRequests: 0,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({ outcome: "held", code: workosAuthenticationRegressionFailure(error) }),
      );
      process.exitCode = 1;
    }
  }
}
