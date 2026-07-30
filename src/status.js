export function createInitialStatus() {
  return {
    state: "idle",
    stage: "idle",
    runId: "",
    startedAt: "",
    completedAt: "",
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
    blankQueriesSkipped: 0,
    storesDiscovered: 0,
    storesQualified: 0,
    storesRejected: 0,
    failures: 0,
    outputRows: 0,
    error: ""
  };
}
