export function createInitialProgress() {
  return {
    shopTypesTotal: 0,
    shopTypesProcessed: 0,
    blankShopTypesSkipped: 0,
    invalidShopTypes: 0,
    queryCandidatesGenerated: 0,
    queryCandidatesValidated: 0,
    queryCandidatesProbed: 0,
    queriesSelected: 0,
    planningWarnings: 0,
    queriesTotal: 0,
    queriesProcessed: 0,
    storesDiscovered: 0,
    storesQualified: 0,
    storesRejected: 0,
    failures: 0,
    outputRows: 0
  };
}

export function createInitialStatus() {
  return {
    state: "idle",
    stage: "idle",
    runId: "",
    startedAt: "",
    completedAt: "",
    ...createInitialProgress(),
    blankQueriesSkipped: 0,
    error: ""
  };
}

export function progressFromStatus(status) {
  const progress = createInitialProgress();
  for (const key of Object.keys(progress)) {
    const value = Number(status?.[key]);
    progress[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return progress;
}
