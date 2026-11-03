# CU Denver Office-Equity-Open-Notebook Compliance & Hardening Repository

This directory contains the regulatory standards, architectural hardening guides, security frameworks, and accessibility verification matrices for the **CU Denver Office-Equity-Open-Notebook** platform.

All artifacts are maintained to ensure complete alignment with:
1. **FERPA (34 CFR Part 99)**: Zero-PII safe harbor, strict role-based access control (RBAC), immutable audit logging (§ 99.32), AES-256 encryption-at-rest, and TLS 1.2+ in-transit encryption.
2. **Colorado State Accessibility (HB 21-1110 & SB 23-244 / WCAG 2.2 Level AA / WCAG2ICT)**: State of Colorado digital accessibility standards, vendor assessment rubrics, and high-contrast design specifications.
3. **Federal Civil Rights & Workplace Accessibility Guidelines**: Equal Employment Opportunity Commission (EEOC) and Department of Education (DOE) Office for Civil Rights (OCR) benchmarks.

---

## Directory Structure

```
docs/compliance/
├── README.md                                           <-- This index
├── ferpa/                                              <-- FERPA Hardening & Security Standards
│   ├── FERPA_Software_Testing_Compliance_Checklist.docx
│   ├── FERPA_Software_Testing_Compliance_Checklist.pdf
│   ├── FERPA_Compliance_Software_Practical_Guide.docx
│   ├── FERPA_Compliance_Software_Practical_Guide.pdf
│   ├── Microsoft_Azure_FERPA_Compliance_Framework_Mapping.docx
│   ├── Microsoft_Azure_FERPA_Compliance_Framework_Mapping.pdf
│   ├── Microsoft_Azure_FERPA_Implementation_Guide.docx
│   ├── Microsoft_Azure_FERPA_Implementation_Guide.pdf
│   └── PORTABLE_PORT_FERPA_COMPLIANCE_MANIFEST.md
└── accessibility/                                      <-- Accessibility & Design Standards
    ├── Colorado_State_Accessibility_Risk_Assessment_Template.xlsx
    ├── Colorado_State_Accessibility_Risk_Assessment_Template.pdf
    ├── State_of_Colorado_Web_and_Accessibility_Manager.pdf
    ├── Educational_and_Promotional_Asset_Design_Specifications.docx
    ├── Educational_and_Promotional_Asset_Design_Specifications.pdf
    ├── EEOC_Workplace_Accessibility_Article.md
    ├── 01_Orchestrator_Google_AI_Studio_Filled.md
    └── 05_Capabilities_Cost_and_Research_References.md
```

---

## 1. FERPA Hardening Suite (`docs/compliance/ferpa/`)

| Document | Format | Description & Compliance Mapping |
| :--- | :--- | :--- |
| **`FERPA_Software_Testing_Compliance_Checklist`** | `.docx`, `.pdf` | Multi-domain automated and manual testing matrix for education software: RBAC verification, sanitization gates, 34 CFR § 99.32 audit trail validation, and break-glass response procedures. |
| **`FERPA_Compliance_Software_Practical_Guide`** | `.docx`, `.pdf` | Operational handbook for schools and EdTech developers implementing student record privacy safeguards, directory information handling, and consent workflows. |
| **`Microsoft_Azure_FERPA_Compliance_Framework_Mapping`** | `.docx`, `.pdf` | Complete control mapping between Azure cloud infrastructure (Entra ID, Key Vault, Azure Monitor, Private Endpoints) and FERPA 34 CFR Part 99 statutory clauses. |
| **`Microsoft_Azure_FERPA_Implementation_Guide`** | `.docx`, `.pdf` | Step-by-step engineering blueprint for standing up FERPA-compliant IaaS/PaaS workloads, data encryption at rest (FIPS 140-2 validated), and append-only diagnostic logging. |
| **`PORTABLE_PORT_FERPA_COMPLIANCE_MANIFEST.md`** | `.md` | Architectural manifest defining the zero-PII boundary, synthetic dossier generation constraints, and local client sandboxing rules. |

---

## 2. Accessibility & Design Suite (`docs/compliance/accessibility/`)

| Document | Format | Description & Compliance Mapping |
| :--- | :--- | :--- |
| **`Colorado_State_Accessibility_Risk_Assessment_Template`** | `.xlsx`, `.pdf` | State of Colorado official vendor and product accessibility risk evaluation worksheet assessing WCAG 2.2 AA criteria, VPAT / ACR reviews, and remediation roadmaps. |
| **`State_of_Colorado_Web_and_Accessibility_Manager.pdf`** | `.pdf` | State guidelines and operational standards for web accessibility compliance under Colorado HB 21-1110 / SB 23-244. |
| **`Educational_and_Promotional_Asset_Design_Specifications`** | `.docx`, `.pdf` | UI/UX specifications for digital interfaces, document exports, typography hierarchy, screen-reader tagging, and 7:1 contrast compliance. |
| **`EEOC_Workplace_Accessibility_Article.md`** | `.md` | EEOC regulatory analysis on disability non-discrimination, reasonable accommodations, and assistive technology interoperability in educational and workplace environments. |
| **`01_Orchestrator_Google_AI_Studio_Filled.md`** | `.md` | Master technical specification orchestrating multi-agent qualitative analysis workflows with integrated accessibility enforcement. |
| **`05_Capabilities_Cost_and_Research_References.md`** | `.md` | Reference guide detailing CU administrative policies (APS 5014, APS 5065), WCAG2ICT applicability, and accessibility evaluation tooling. |

---

## Regulatory Authority & Standards Summary

- **FERPA**: 34 CFR Part 99 (Family Educational Rights and Privacy Act), U.S. Department of Education Student Privacy Policy Office (SPPO).
- **Colorado Digital Accessibility**: Colorado Revised Statutes § 24-85-101 et seq., HB 21-1110, SB 23-244, and Governor's Office of Information Technology (OIT) Accessibility Rules.
- **W3C Standards**: Web Content Accessibility Guidelines (WCAG) 2.2 Level A/AA, Guidance on Applying WCAG 2.2 to Non-Web Information and Communications Technologies (WCAG2ICT).
- **University of Colorado Policies**: CU Administrative Policy Statement (APS) 5014 (*Digital Accessibility*) and APS 5065 (*Student Education Records*).
