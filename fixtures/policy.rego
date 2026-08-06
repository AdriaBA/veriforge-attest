package veriforge.attest

# Minimal Rego policy fixture: compile factual evidence checks into VeriForge policy rules.
block["Unit tests failed — merge blocked by policy."] if {
  evidence_outcome("unit_tests", "failed")
}

review["Dependency scan reported failures — human review required."] if {
  evidence_outcome("dependency_scan", "failed")
}
