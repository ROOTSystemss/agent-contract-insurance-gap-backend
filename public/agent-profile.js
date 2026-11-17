// Agent profile: one place that turns form answers into the API payload, shared by the classic form and the
// step-by-step wizard (N-AT-04, knock-out 2026-11-17), so both always write the same profile. Plain browser script
// (window.AgentProfile); the tests load it in a sandbox. Decision support only: nothing here is legal or
// insurance advice.
(function (root) {
  "use strict";
  // Plain-English hints for the capabilities buyers find unclear (Max Additions AD-072, 2026-11-13).
  const capabilityHints = {
    canMakeRepresentations: "Tells customers things on your behalf, such as prices, promises or facts about a product.",
    canAcceptTerms: "Clicks \"I agree\" or accepts conditions for your company.",
    canExecuteTransactions: "Completes an order, booking, transfer or refund itself, not just a draft.",
    canEnterContracts: "Signs or agrees to a contract for your company.",
    canAccessSensitivePersonalData: "Health, financial, ID numbers, or similar special data about people.",
    canAccessRegulatedData: "Data a law controls, such as patient records (HIPAA) or card numbers (PCI).",
    canCreateIntellectualProperty: "Writes text, code or designs your company will own or publish.",
    canDelegateToSubAgents: "Hands tasks to other AI agents or bots.",
    canControlInfrastructure: "Changes servers, cloud settings or networks.",
  };
  const capabilityFields = [
    ["canCommunicateExternally", "Communicate externally"],
    ["canMakeRepresentations", "Make representations"],
    ["canAcceptTerms", "Accept terms"],
    ["canExecuteTransactions", "Execute transactions"],
    ["canSpendMoney", "Spend money"],
    ["canIssueRefundsOrCredits", "Issue refunds or credits"],
    ["canChangePrices", "Change prices"],
    ["canEnterContracts", "Enter contracts"],
    ["canApproveOrRejectPeople", "Approve or reject people"],
    ["canApproveOrRejectVendors", "Approve or reject vendors"],
    ["canAccessPersonalData", "Access personal data"],
    ["canAccessSensitivePersonalData", "Access sensitive personal data"],
    ["canAccessConfidentialBusinessData", "Access confidential business data"],
    ["canAccessRegulatedData", "Access regulated data"],
    ["canModifyOrDeleteData", "Modify or delete data"],
    ["canCreateIntellectualProperty", "Create intellectual property"],
    ["canPublishContent", "Publish content"],
    ["canDeployCode", "Deploy code"],
    ["canControlInfrastructure", "Control infrastructure"],
    ["canHireOrTerminateWorkers", "Hire or terminate workers"],
    ["canDelegateToSubAgents", "Delegate to sub-agents"],
  ];

  const commaList = (value) => (value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : []);
  const lineList = (value) => (value ? String(value).split("\n").map((item) => item.trim()).filter(Boolean) : []);
  const optionalText = (value) => (value === undefined || value === null || String(value).trim() === "" ? undefined : String(value));
  const optionalNumber = (value) => (value === undefined || value === null || String(value).trim() === "" ? undefined : Number(value));

  // values: the answers as strings (form field names), with capability answers as booleans.
  function buildAgentPayload(values) {
    const v = values || {};
    const payload = {
      name: v.name,
      deploymentStatus: v.deploymentStatus,
      businessPurpose: v.businessPurpose,
      operatorOrganization: v.operatorOrganization,
      developerProvider: optionalText(v.developerProvider),
      deploymentCountries: commaList(v.deploymentCountries).map((c) => c.toUpperCase()),
      affectedCountries: commaList(v.affectedCountries).map((c) => c.toUpperCase()),
      primaryJurisdiction: String(v.primaryJurisdiction || "").toUpperCase(),
      jurisdictionSubdivisions: [],
      agentType: v.agentType,
      autonomyLevel: Number(v.autonomyLevel),
      humanOversightLevel: v.humanOversightLevel,
      perTransactionLimit: optionalNumber(v.perTransactionLimit),
      aggregateSpendingLimit: optionalNumber(v.aggregateSpendingLimit),
      currency: v.currency ? String(v.currency).toUpperCase() : undefined,
      reversibility: v.reversibility,
      loggingLevel: v.loggingLevel,
      approvalThresholds: commaList(v.approvalThresholds),
      thirdPartyToolsUsed: commaList(v.thirdPartyToolsUsed),
      systemsAccessed: commaList(v.systemsAccessed),
      emergencyStopMechanism: optionalText(v.emergencyStopMechanism),
      incidentResponseOwner: optionalText(v.incidentResponseOwner),
      knownLimitations: lineList(v.knownLimitations),
      notes: optionalText(v.notes),
    };
    capabilityFields.forEach(([name]) => { payload[name] = v[name] === true || v[name] === "on" || v[name] === "true"; });
    if (!payload.canSpendMoney) {
      delete payload.perTransactionLimit;
      delete payload.aggregateSpendingLimit;
      delete payload.currency;
    }
    return payload;
  }

  // Wizard: one plain-English question per step. Each step lists the form fields it fills; the review step shows
  // every answer before saving. "check" returns a message when the step cannot go on (the server re-validates all).
  const WIZARD_STEPS = [
    { id: "what", title: "What does the agent do?", help: "In one or two sentences, the job it does for your company.",
      fields: [["name", "Give it a name", "text"], ["businessPurpose", "What job does it do?", "textarea"], ["agentType", "What kind of agent is it? (e.g. invoice assistant)", "text"], ["deploymentStatus", "Is it planned, in a pilot, live, or retired?", "select:planning,pilot,production,retired"]],
      check: (v) => (!v.name || String(v.name).trim().length < 2 ? "Give the agent a name (2 characters or more)." : !v.businessPurpose || String(v.businessPurpose).trim().length < 5 ? "Say in a few words what job it does." : !v.agentType || String(v.agentType).trim().length < 2 ? "Say what kind of agent it is." : null) },
    { id: "where", title: "Who runs it, and where?", help: "Two-letter country codes, e.g. US, GB, DE.",
      fields: [["operatorOrganization", "Which organization runs it?", "text"], ["developerProvider", "Who built it? (optional)", "text"], ["primaryJurisdiction", "Which country's law mainly applies?", "text"], ["deploymentCountries", "Where is it used? (comma-separated)", "text"], ["affectedCountries", "Where do the people it deals with live, if different? (optional)", "text"]],
      check: (v) => (!/^[A-Za-z]{2}$/.test(String(v.primaryJurisdiction || "").trim()) ? "Use a two-letter country code for the main country, e.g. US." : !commaList(v.deploymentCountries).length || commaList(v.deploymentCountries).some((c) => !/^[A-Za-z]{2}$/.test(c)) ? "List where it is used as two-letter codes, separated by commas." : !v.operatorOrganization || String(v.operatorOrganization).trim().length < 2 ? "Say which organization runs it." : null) },
    { id: "systems", title: "Which systems does it touch?", help: "The tools and systems it can read or change. Separate with commas.",
      fields: [["systemsAccessed", "Systems it can use (e.g. CRM, purchasing system)", "text"], ["thirdPartyToolsUsed", "Outside tools it relies on (e.g. Stripe)", "text"]],
      check: () => null },
    { id: "actions", title: "What is it allowed to do?", help: "Tick everything it can do, even if a person approves first.",
      fields: capabilityFields.map(([name, label]) => [name, label, "checkbox"]),
      check: () => null },
    { id: "money", title: "Money limits", help: "Only if it can spend money. Leave empty otherwise.",
      fields: [["perTransactionLimit", "Most it may move in one action", "number"], ["aggregateSpendingLimit", "Most it may move in total (optional)", "number"], ["currency", "Currency (e.g. USD)", "text"]],
      check: (v) => {
        const spends = v.canSpendMoney === true || v.canSpendMoney === "on";
        if (spends && (optionalNumber(v.perTransactionLimit) === undefined || !/^[A-Za-z]{3}$/.test(String(v.currency || "").trim()))) return "It can spend money, so give a per-action limit and a three-letter currency.";
        if (!spends && (optionalNumber(v.perTransactionLimit) !== undefined || optionalNumber(v.aggregateSpendingLimit) !== undefined)) return "Limits only apply if it can spend money. Go back and tick \"Spend money\", or clear the limits.";
        return null;
      } },
    { id: "approval", title: "Who checks its work?", help: "How much it acts on its own, and when a person must say yes first.",
      fields: [["autonomyLevel", "How independent is it? 0 = only suggests, 5 = acts fully on its own", "select:0,1,2,3,4,5"], ["humanOversightLevel", "When does a person check?", "select:continuous,pre_action_approval,threshold_approval,periodic_review,exception_only,none"], ["approvalThresholds", "Rules for when a person must approve first (comma-separated)", "text"], ["reversibility", "Can its mistakes be undone?", "select:fully_reversible,partially_reversible,irreversible,unknown"], ["loggingLevel", "How much of what it does is recorded?", "select:none,basic,detailed,tamper_evident"]],
      check: () => null },
    { id: "safety", title: "If something goes wrong", help: "Optional, but reviewers look for these.",
      fields: [["emergencyStopMechanism", "How does someone stop it right now?", "text"], ["incidentResponseOwner", "Who is called when it does something wrong?", "text"], ["knownLimitations", "Known limitations (one per line)", "textarea"], ["notes", "Notes for the reviewer", "textarea"]],
      check: () => null },
  ];

  function wizardCheck(stepIndex, values) {
    const step = WIZARD_STEPS[stepIndex];
    return step ? step.check(values || {}) : null;
  }

  const api = { capabilityHints, capabilityFields, buildAgentPayload, WIZARD_STEPS, wizardCheck, commaList };
  root.AgentProfile = api;
})(typeof window !== "undefined" ? window : globalThis);
