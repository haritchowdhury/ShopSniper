import { PipelineInvariantError } from "../contracts/errors.js";

export function createPipelineLeaseMonitor({
  renew,
  intervalMs,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  if (typeof renew !== "function" || ![20000, 40000].includes(intervalMs) || typeof now !== "function" ||
      typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  let failure;
  let pending = Promise.resolve();
  let stopped = false;
  const capture = (error) => {
    failure ??= error;
    throw error;
  };
  const runRenewal = () => {
    pending = pending.then(() => {
      if (failure) throw failure;
      const current = now();
      if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      return renew(current);
    }).catch(capture);
    pending.catch(() => {});
    return pending;
  };
  const timer = setIntervalFn(() => { if (!stopped) runRenewal(); }, intervalMs);
  return Object.freeze({
    assertActive() {
      if (failure) throw failure;
    },
    async renewNow() {
      if (failure) throw failure;
      return runRenewal();
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearIntervalFn(timer);
      }
      try { await pending; } catch {}
      if (failure) throw failure;
    }
  });
}

export async function preparePipelineTerminalLease(monitor) {
  await monitor.renewNow();
  await monitor.stop();
  monitor.assertActive();
}
