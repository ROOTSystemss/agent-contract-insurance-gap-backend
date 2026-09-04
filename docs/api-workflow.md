# API Workflow

1. Register; an organization and owner membership are created atomically.
2. Authenticate and send the JWT as `Authorization: Bearer …`.
3. Create a project with a primary ISO country and optional subdivision/affected countries.
4. Create the structured AI-agent profile.
5. Upload PDF, DOCX, or TXT documents using multipart form data and metadata query parameters.
6. Inspect extraction status. `ocr_required` means analysis cannot pretend scanned content was read.
7. Create an analysis with one agent-profile ID and selected document IDs.
8. Run or rerun it. Findings and score are deterministic and ruleset-versioned.
9. Review findings and update their workflow status.
10. Retrieve report-ready JSON and the project audit trail.

Success responses use `{ data, meta, requestId }`; errors use `{ error: { code, message, details, requestId } }`. Lists accept `page` and `pageSize`.
