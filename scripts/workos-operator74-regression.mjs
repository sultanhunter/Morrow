import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWorkosOperator74Regression,
  workosRegressionFailureDiagnostic,
} from "./workos-operator-regression.mjs";

// Fixed synthetic entrypoint only. No private root, provider input or alternate
// fixture/runner is accepted; the completed native74 allowance stays consumed.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("WORKOS_REGRESSION_INPUT_DENIED");
    process.exitCode = 1;
  } else {
    try {
      const report = await runWorkosOperator74Regression();
      console.log(
        JSON.stringify({
          packet: report.packet,
          checks: report.checks.length,
          realProviderRequests: 0,
          syntheticProviderRequests: 2,
          syntheticJwksReads: 9,
          archiveUnchanged: true,
          status: report.status,
        }),
      );
    } catch (error) {
      console.error(
        "WORKOS_REGRESSION_FAILED " + JSON.stringify(workosRegressionFailureDiagnostic(error)),
      );
      process.exitCode = 1;
    }
  }
}
