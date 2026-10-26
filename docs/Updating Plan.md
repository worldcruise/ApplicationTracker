# Resume Tailoring Studio

## Product and Technical Design Document

**Status:** Proposed design based on agreed product decisions\
**Scope:** Web application, Chrome extension, candidate configuration, prompt templates, document templates, and local file management\
**Storage strategy:** JSON-first configuration under `config/`, designed for future database migration\
**Extension strategy:** Chrome extension with user-granted directory access, without requiring Python Native Messaging for the new file-management workflow

---

# 1. Product Overview

## 1.1 Vision

Resume Tailoring Studio is a multi-candidate resume-tailoring application that combines candidate profile management, reusable AI prompt templates, visual resume templates, resume generation, document preview, and PDF export.

The application consists of two connected experiences:

1. **Web application:** The primary workspace for managing candidates, configuring profiles, selecting templates, generating tailored resumes, customizing document layouts, previewing, and downloading documents.
2. **Chrome extension:** A lightweight workspace for working directly from a job posting, copying a job-specific AI prompt, validating generated resume JSON, previewing documents, accessing candidate information, and saving application files to a user-selected local folder.

The existing candidate-management workflow and resume-generation functionality are the foundation of the redesign.

The objective is to improve the user experience without rebuilding working functionality or introducing unnecessary infrastructure.

## 1.2 Core product principles

- Preserve the existing multi-candidate workflow and candidate source.
- Adopt the visual direction of the supplied UI references.
- Keep candidate profiles, AI prompt templates, and visual document templates separate.
- Automatically use each candidate's assigned AI prompt.
- Remember a preferred visual template for each candidate while allowing per-resume alternatives.
- Keep web resume downloads user-initiated.
- Automatically open the extension's resume preview when pasted CV JSON passes validation.
- Save application files only after the user clicks Save.
- Use structured JSON configuration for persistent application records.
- Avoid a Python Native Messaging dependency for the new bid-folder workflow.
- Protect existing files by blocking saves into company folders that already contain files.

# 2. Scope and Existing Functionality

## 2.1 Existing functionality to preserve

The application already has a multi-candidate workflow. The redesign must retain the existing candidate source and its associated functionality, including:

- Candidate creation, editing, deletion, and selection.
- Candidate-specific resume profile information.
- Candidate-specific history-folder paths.
- Existing prompt-file paths and prompt behavior.
- Existing Chrome extension integration and extension identifiers.
- Existing background-script functionality that remains relevant.
- Resume generation, structured JSON processing, preview, and PDF export.
- Existing profile fields, repeatable sections, and validation behavior.

The current implementation must be audited before changing data structures or removing legacy integrations.

No existing candidate records, profile fields, history folders, or prompt files should be silently discarded during migration.

## 2.2 Explicit non-goals

This phase does not include:

- Rebuilding the application as a general job-application CRM.
- Replacing the existing resume-generation engine.
- Introducing a database immediately.
- Requiring a cloud backend for basic local file operations.
- Replacing the current candidate source with a new candidate-management system.
- Automatically saving every web-generated resume to candidate history.
- Automatically overwriting existing application files.
- Introducing Python Native Messaging solely to support the new bid-folder workflow.

# 3. Web Application Design

## 3.1 Navigation

The primary navigation should contain:

- Home
- Candidates
- Profile
- Preview
- Prompt Templates
- About
- Contact
- Theme

Use the supplied screenshots as the visual reference: a dark interface, blue accents, modern cards, consistent form controls, clear section hierarchy, and responsive layouts.

The redesign should adapt the existing components rather than replacing their business logic.

## 3.2 Home

Home focuses on the currently active candidate.

The page should display:

- Active candidate name and professional headline.
- Profile completeness or readiness.
- Key candidate information.
- Available resume templates.
- Shortcuts to Profile and Preview.
- A primary action to start resume creation.
- Useful workflow or generation-status indicators.

The page must display actual data from the existing candidate source rather than hardcoded sample values.

Home is a summary and navigation screen, not a duplicate profile editor.

## 3.3 Candidates

Preserve the existing multi-candidate management experience and modernize its presentation.

Candidate cards or rows should display the existing relevant information, including:

- Candidate name.
- Active-candidate status.
- History-folder path.
- Assigned prompt template.
- Chrome extension identifier, if currently displayed.
- Existing edit, delete, activate, and refresh actions where applicable.

The interface should show the friendly name of the assigned prompt template instead of requiring users to understand internal file paths.

All existing candidate-management actions must continue working.

## 3.4 Profile

Retain the original Profile page and its existing fields.

Apply the new visual design without removing supported functionality.

Organize the existing fields into logical sections, such as:

- Personal Information.
- Online Presence.
- Integrations.
- Work Experience.
- Education.
- Technical Skills.
- Certifications and Additional Information.

The actual field inventory must come from the existing implementation.

Repeatable work-experience and education sections must continue to work where currently supported. Validation, add/remove controls, and existing integrations must be preserved.

Each profile is associated with one candidate. Editing one candidate must not modify another candidate's information.

## 3.5 Preview

Retain the three-column document workspace from the supplied screenshot.

**Left panel — Document customization**

- Typography and font sizes.
- Margins and page layout.
- Heading and section styling.
- Spacing and alignment.
- Supported section-ordering and visibility controls.

**Center panel — Document preview**

- Rendered resume or PDF.
- Zoom and page navigation.
- Page count and rendering status.
- Preview refresh when supported settings change.

**Right panel — AI assistant**

- Existing prompt workflow.
- Structured JSON response.
- Validation status and error messages.
- Existing copy and generation actions where supported.

Customization controls must only be exposed when they actually affect the rendered document.

### Web resume workflow

1. Select the candidate.
2. Start a new resume.
3. Choose a visual document template.
4. Paste the job description.
5. Automatically use the candidate's assigned AI prompt.
6. Generate the tailored resume using the existing generation engine.
7. Validate the generated content.
8. Render the resume in Preview.
9. Download the PDF when satisfied.

**Web save behavior:** Generating a resume opens the preview. The application does not automatically save each generation as a permanent candidate-history record. The user initiates the download to save the resulting document.

# 4. Prompt Templates

## 4.1 Purpose

Add a dedicated Prompt Templates navigation item.

This is a reusable library of AI instructions, independent of visual document templates.

Users should be able to:

- Create prompt templates.
- View and edit existing templates.
- Duplicate templates.
- Assign templates to candidates.
- Import compatible existing prompt files.
- Archive templates that should no longer be selected.

Each template should have a friendly name, description, prompt body, stable identifier, and version.

## 4.2 Candidate prompt assignment

Each candidate has one assigned default AI prompt template.

The assignment is configured through the existing Add Candidate or Edit Candidate workflow.

For every new resume:

- The assigned prompt is selected automatically.
- The user does not need to select the prompt again.
- The prompt is combined with the job description when the extension's Copy Prompt action is used.
- Existing prompt-file expectations are preserved through a compatibility mechanism where required.

Changing a candidate's assigned prompt must not change the assignment for other candidates.

Prompt-template edits should be versioned so the application can identify which instructions were used for a particular generation.

## 4.3 Prompt templates versus document templates

These are two separate systems.

| Prompt templates                              | Document templates                                 |
| --------------------------------------------- | -------------------------------------------------- |
| Control AI instructions and generated content | Control document appearance                        |
| Assigned to each candidate                    | A preferred template is assigned to each candidate |
| Used automatically for resume generation      | Preselected when starting a new resume             |
| Combined with the JD for extension copying    | Used by the document renderer                      |
| Managed through Prompt Templates              | Managed through the visual template gallery        |

Changing a document template must not silently change the AI prompt.

# 5. Document Templates

## 5.1 Template gallery

The Preview workflow should include a visual gallery of resume designs.

Each template card should include:

- Thumbnail generated from the actual document layout.
- Template name.
- Short description.
- Layout classification.
- Selected state.
- Use Template or Customize action.

Potential categories include traditional, modern, compact, technical, and minimalist designs.

## 5.2 Template preference

Each candidate has a preferred visual document template.

When starting a new resume, the preferred template is selected automatically. The user may choose a different template for that individual resume.

The per-resume selection must not silently overwrite the candidate's preferred template.

Template definitions and candidate-specific template preferences must remain separate.

## 5.3 Thumbnails

Thumbnails should reflect actual template layouts rather than unrelated stock images.

They should use sample or appropriately redacted content, avoiding real candidate contact details in shared preview assets.

Thumbnail generation should be cached where practical and refreshed when the underlying template changes.

# 6. Chrome Extension Design

The extension has a login screen and two primary tabs.

## 6.1 Login

The login screen contains:

- Candidate full name.
- Password.
- Login action.

After successful login, the extension loads the corresponding candidate's configuration and displays the candidate-specific workspace.

The extension must not accidentally use another candidate's prompt, profile, custom answers, or output filename.

The login mechanism must be evaluated against the existing authentication design. A client-side name/password check with a plaintext password stored in JSON is not secure authentication; passwords should not be stored in plaintext.

## 6.2 Tab 1 — Resume Workspace

This tab contains three sections.

### Section A: Job Description (JD)

The user pastes the job description into the JD input.

The Copy Prompt action:

1. Reads the JD text.
2. Loads the active candidate's assigned prompt template.
3. Combines the prompt instructions with the JD.
4. Copies the combined text to the clipboard.
5. Captures the current browser tab URL for the job's metadata.

The combined prompt is intended for AI generation.

The saved JD artifact must contain only the original JD, without the prompt instructions.

The current tab URL should be captured at the time of job capture and preserved in the job metadata. If the URL itself must be copied to the clipboard, provide a separate Copy URL action so it does not overwrite the combined prompt.

The existing background-script workflow should be reused where appropriate. For the enhanced workflow, the extension checks the selected folder's accessibility rather than depending on Python to create or inspect folders.

### Section B: CV

The CV section accepts pasted JSON representing the generated resume.

Behavior:

1. Detect pasted or changed CV content.
2. Parse and validate the JSON.
3. Display validation errors when the content is invalid.
4. When validation succeeds, automatically turn on the Preview toggle.
5. Automatically open the resume preview modal.
6. Render the document using the existing preview functionality.

Invalid JSON must not activate the preview or permit saving an invalid resume.

If the modal is closed, the Preview toggle automatically turns off. If the user turns the toggle off, the modal closes.

The preview state and toggle state must remain synchronized.

The extension's preview is not itself a save operation.

### Section C: Cover Letter

The cover-letter section is optional.

A toggle shows or hides the section.

When enabled, the user can provide or review the cover-letter content using the supported existing workflow. When disabled, the section is hidden without disrupting the JD or CV sections.

A cover-letter PDF is generated and saved only when valid cover-letter content is present.

## 6.3 Tab 2 — Candidate Personal Information

This tab provides quick access to candidate-specific information through three accordions.

### Accordion 1: Personal Information

Fields:

- Full name.
- Birthday.
- Full address.
- Phone number.
- Email address.
- Default password.

The information comes from the selected candidate's configuration.

The password field requires appropriate protection and must not expose plaintext credentials unnecessarily.

### Accordion 2: Career and Education

**Company 1**

- Company name and employment period.
- Address line 1.
- City and state.
- ZIP code.
- Copy Full Address action.

**Company 2**

- Company name and employment period.
- Address line 1.
- City and state.
- ZIP code.
- Copy Full Address action.

**University**

- University name and relevant period.
- Address line 1.
- City and state.
- ZIP code.
- Copy Full Address action.

**Degree and Major**

- Degree.
- Major.
- Copy Details action.

Copy actions should format the relevant fields into useful clipboard text, omitting empty address components rather than producing malformed addresses.

### Accordion 3: Custom Answers and Prompts

This section contains candidate-specific answers and reusable instructions.

**Custom answers**

| Field              | Example value                          | Editability |
| ------------------ | -------------------------------------- | ----------- |
| Reason for leaving | Technical ownership, work-life balance | Read-only   |
| Notice period      | 2 weeks                                | Read-only   |
| Start date         | 9-Nov                                  | Editable    |

The start date is the only editable item in this accordion.

The displayed examples are initial configuration values, not hardcoded values for every candidate. Each candidate retains their own configured answers.

**Custom prompt 1 — Resume-generation confirmation**

“I have that and can verify that, so please go on and generate the resume.”

**Custom prompt 2 — Short interview answers**

“Please give me professional, uncommon, positive, super-short answers to each question. Use a natural, confident speaking style with human emotion. Keep sentences short, concise, and informal. No em dashes.”

These prompts remain distinct from the candidate's assigned resume-generation template.

# 7. Local File Management

## 7.1 Bid root folder selection

The extension will use a user-selected local bid root folder rather than requiring Python Native Messaging for the new file-management workflow.

The first time directory access is needed:

1. The user selects the bid root folder through the browser's directory picker.
2. The extension obtains permission to access it.
3. The directory handle is persisted in extension-origin IndexedDB where supported.
4. Subsequent operations reuse the handle after checking permission.
5. If permission is revoked or unavailable, the extension requests access again through a user interaction.

A stored handle does not guarantee permanent permission. Every relevant operation must check that access is still valid.

The extension must not silently fall back to an unrelated directory.

## 7.2 Company name resolution

The company name comes from the JSON record used by the save workflow.

The resolution rules are:

1. Read the company name from the JSON.
2. Validate that it is a usable folder name.
3. If the company name is missing or invalid, display a company-name input.
4. Allow the user to enter the name manually.
5. Do not ask for manual entry when the JSON already contains a valid company name.

The extension must not infer the company name solely from the current tab's domain.

Folder-name normalization should handle filesystem-invalid characters and unsafe path components. The displayed company name should remain understandable to the user.

## 7.3 Folder structure

The extension uses the selected bid root folder and creates one company folder per save operation.

Example:

```text
Selected Bid Root/
├── Company Alpha/
│   ├── JobDescription.txt
│   ├── JobDescription.json
│   ├── Alex Morgan.pdf
│   └── CoverLetter.pdf
└── Company Beta/
    ├── JobDescription.txt
    ├── JobDescription.json
    └── Alex Morgan.pdf
```

The names shown are illustrative.

The company folder name is derived from the resolved company name. The resume PDF filename uses the candidate's full name.

## 7.4 Save operation

The Save button in the extension initiates the following process:

1. Validate the JD and CV data.
2. Resolve and validate the company name.
3. Recheck access to the selected bid root folder.
4. Check whether the company folder exists.
5. Create the company folder if it does not exist.
6. If the company folder contains files, abort the entire operation and display an alert toast.
7. If the company folder exists but is empty, allow saving.
8. Generate or finalize the required document files.
9. Write the files and report the actual result.

The extension must complete the duplicate check before writing any files.

### Output artifacts

| File                  | Contents                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `JobDescription.txt`  | Original JD text only                                                                                              |
| `JobDescription.json` | Structured job record, including the original JD, resolved company name, source URL, and relevant capture metadata |
| `Full Name.pdf`       | Rendered resume PDF                                                                                                |
| `CoverLetter.pdf`     | Rendered cover-letter PDF, only when applicable                                                                    |

The combined JD-plus-prompt clipboard content must never be written into the saved JD text file.

The job JSON must preserve the JD itself separately from any prompt template used to generate the resume.

The current output list does not require a separate saved CV JSON artifact; the CV JSON is used for validation and rendering. If the existing implementation already requires that artifact, preserve it through the source-code audit rather than silently removing it.

## 7.5 Duplicate-folder protection

The required behavior is **create if missing, stop if occupied**.

| Condition                              | Required action                 |
| -------------------------------------- | ------------------------------- |
| No bid root folder selected            | Ask the user to select one      |
| Bid root folder is inaccessible        | Stop and display an alert toast |
| Company name missing from JSON         | Request manual entry            |
| Company folder does not exist          | Create the folder and save      |
| Company folder exists and is empty     | Save                            |
| Company folder already contains files  | Stop and display an alert toast |
| Access is revoked during the operation | Stop and report the failure     |

Example toast:

**Application folder already exists**

Files already exist for this company. Nothing was saved to prevent overwriting your existing application.

If a save is blocked, none of the requested files should be written.

If a failure occurs after writing begins, the extension should clean up newly created partial artifacts where possible without deleting pre-existing files. It must report any cleanup failure rather than claiming that nothing was saved.

## 7.6 Current tab URL

The extension captures the current tab URL associated with the JD.

The URL should be included in the structured job metadata so the source posting can be revisited.

Clipboard copying of the URL must be a separate action from copying the combined JD-plus-prompt text, since the clipboard holds only one current value.

# 8. JSON-First Configuration Architecture

## 8.1 General strategy

All persistent application records that would otherwise be stored in a database should initially be represented as structured JSON under the application's `config/` directory.

The JSON storage layer should be accessed through repository interfaces. UI components must not independently implement file reading and writing.

This makes the initial implementation simple while providing a migration path to a database later.

## 8.2 Proposed logical structure

Adapt the existing structure to avoid duplicating or relocating working data unnecessarily.

```text
config/
├── candidates.json
├── app-settings.json
├── prompt-templates.json
├── document-templates.json
├── profiles/
│   ├── candidate-id-1.json
│   └── candidate-id-2.json
├── templates/
│   └── existing prompt compatibility files
└── backups/
    └── recovery snapshots
```

The structure is a proposed logical target. Existing files should be reused when they already perform these functions.

### Candidate registry

Contains:

- Stable candidate ID.
- Candidate name.
- Existing history-folder path.
- Existing extension identifier.
- Assigned prompt-template ID.
- Preferred document-template ID.
- Profile reference.
- Existing compatibility fields needed by the current implementation.
- Creation and update timestamps.

The active-candidate reference must remain consistent with the existing candidate-selection workflow.

### Candidate profile

Contains the existing resume-profile fields, including personal information, work experience, education, skills, and certifications.

Each profile should have a stable candidate ID and schema version.

### Prompt templates

Contains:

- Stable template ID.
- Name and description.
- Prompt body.
- Category.
- Version.
- Default or archived status.
- Timestamps.

### Document templates

Contains:

- Stable template ID.
- Name and description.
- Renderer or layout identifier.
- Supported formatting options.
- Default styling settings.
- Thumbnail reference or generation metadata.
- Template version.

### Application settings

Contains global UI preferences, theme, and application-level options.

Candidate-specific settings should not be duplicated in global application settings.

## 8.3 Schema and persistence rules

- Use stable identifiers for candidates and templates.
- Include schema versions for records that require migration.
- Validate JSON before writing or consuming it.
- Preserve existing valid data during migration.
- Use safe write procedures, temporary files, and atomic replacement where supported.
- Keep backups or recovery copies when appropriate.
- Do not silently overwrite malformed configuration files.
- Avoid hardcoding secrets in configuration.
- Keep external history-folder paths intact unless the user explicitly changes them.

## 8.4 Critical constraint: shared configuration without a native host

The selected-directory approach removes the need for Python Native Messaging for the bid-folder operations. However, it does not automatically grant the Chrome extension access to the application's existing `config/` directory.

If the web application and extension must share the same live JSON records without a native host, both contexts need an explicit, supported way to access the configuration directory. Their directory handles and permissions are managed separately, and each context must be able to revalidate access.

The implementation must choose and verify one of these strategies:

- Grant directory access to the configuration folder from both the web application and extension, if supported by the target browser contexts.
- Use an explicit import/export or synchronization workflow between the web app's JSON records and extension storage.
- Retain an existing local integration only if automatic cross-context sharing is a mandatory requirement that cannot be satisfied through supported browser APIs.

Do not assume that selecting the bid root folder also grants access to the application's configuration folder.

This is a technical constraint to resolve during the source-code audit, not a reason to replace the existing candidate source.

# 9. Recommended Application Architecture

Separate the application into logical layers.

## UI layer

Responsible for:

- Navigation and page layouts.
- Candidate and profile forms.
- Prompt-template management.
- Document-template selection.
- Resume preview.
- Extension modal and toggle behavior.
- User feedback and validation messages.

## Application-service layer

Responsible for:

- Candidate operations.
- Candidate prompt and document-template assignments.
- Resume generation.
- JD-plus-prompt composition.
- CV JSON validation.
- PDF generation and export.
- Save-operation orchestration.

## Repository layer

Provides centralized interfaces for:

- Candidates.
- Candidate profiles.
- Prompt templates.
- Document templates.
- Application settings.

The initial implementation uses JSON-backed repositories.

## Integration layer

Responsible for:

- Existing background-script behavior.
- Browser tab URL capture.
- Clipboard access.
- Directory permission management.
- Local file reads and writes.
- PDF rendering.
- Existing extension compatibility behavior.

Keep browser file-access operations out of the profile form and other presentation components.

# 10. Security, Privacy, and Data Integrity

The implementation must account for:

- Candidate personal information.
- Passwords and other credentials.
- Locally stored profiles and prompt templates.
- Clipboard contents.
- File-system permissions.
- Potentially sensitive job and resume data.

Passwords must not be stored in plaintext in JSON. If candidate login is only a local convenience gate, document that limitation clearly; if actual authentication is required, use an appropriate authentication design.

The extension should request only the permissions it needs, access only user-selected directories, and avoid sending candidate information to external services unless the existing workflow requires it and the user has authorized that behavior.

Candidate data and generated PDFs must not be exposed in public template thumbnails or accidentally included in source control.

# 11. Error Handling

The application should handle the following cases gracefully:

- Missing or invalid candidate configuration.
- Missing prompt-template references.
- Missing or malformed JD data.
- Invalid CV JSON.
- Invalid company names.
- Missing bid root folder.
- Revoked directory permissions.
- Existing non-empty company folders.
- Failed folder creation.
- Failed PDF generation.
- Failed file writes.
- Partial-save failures.
- Unsaved profile changes.
- Missing or outdated document templates.
- Malformed JSON configuration.
- Compatibility failures involving existing extension or native-host integrations.

Every failure should provide a clear message and a reasonable next action.

# 12. Implementation Plan

## Phase 1 — Source audit

Inspect the current project to identify:

- Candidate registry and profile schemas.
- Existing history-folder and prompt-file behavior.
- Current `background.js` responsibilities.
- Existing native-host dependencies.
- Resume-generation and preview implementations.
- Current JSON and PDF formats.
- Current extension permissions.

Record what already works before changing anything.

## Phase 2 — Configuration and template model

Introduce or adapt the JSON-backed repositories.

Preserve existing candidate IDs and prompt-file paths. Import existing prompt templates without deleting the original files.

Add candidate-level assigned prompt and preferred document-template references where needed.

## Phase 3 — Web UI modernization

Apply the supplied visual design to Home, Candidates, Profile, Preview, and Prompt Templates.

Preserve existing profile fields and candidate operations.

Implement the template gallery, thumbnail workflow, and candidate-level visual-template preference.

## Phase 4 — Extension UX

Implement or restyle:

- Candidate login.
- JD workspace and Copy Prompt action.
- CV JSON validation.
- Automatic Preview toggle and modal synchronization.
- Optional cover-letter section.
- Personal Information tab and three accordions.
- Candidate-specific custom answers and prompts.

## Phase 5 — Directory access and save workflow

Implement user-selected bid root folder access.

Add company-name resolution, folder existence checks, duplicate-folder protection, PDF generation, and file-save handling.

Verify that no save operation overwrites existing files.

## Phase 6 — Integration and regression testing

Verify:

- Candidate isolation.
- Prompt assignment.
- Web resume generation and downloads.
- Extension JD copying.
- Automatic preview behavior.
- Directory permissions.
- Company-folder creation and duplicate detection.
- PDF correctness.
- JSON configuration recovery.
- Existing background-script and native-host compatibility.

Remove legacy dependencies only after their replacement has been verified.

# 13. Acceptance Criteria

## Web application

- [ ] Home displays the active candidate and useful shortcuts.
- [ ] Existing multi-candidate management remains functional.
- [ ] Existing Profile fields and validation are preserved.
- [ ] Prompt Templates is accessible through navigation.
- [ ] Candidates can be assigned a default AI prompt.
- [ ] Document templates display meaningful thumbnails.
- [ ] Each candidate has a preferred visual template.
- [ ] A resume can use a different template without changing the candidate's preference.
- [ ] Resume creation follows the template-first workflow.
- [ ] The assigned AI prompt is used automatically.
- [ ] Web-generated resumes are previewed and saved through user-initiated download.

## Chrome extension

- [ ] Candidate login loads the correct candidate context.
- [ ] The JD Copy Prompt action combines the JD with the assigned prompt.
- [ ] The current tab URL is captured for job metadata.
- [ ] Saved JD content excludes prompt instructions.
- [ ] Valid pasted CV JSON automatically enables Preview and opens the modal.
- [ ] Invalid JSON displays validation errors and does not open Preview.
- [ ] Closing the modal turns Preview off.
- [ ] The cover-letter section can be shown or hidden.
- [ ] Personal Information contains the three agreed accordions.
- [ ] Start date is the only editable custom answer in Accordion 3.
- [ ] Saving rechecks folder access and the company folder.
- [ ] A missing company folder is created automatically.
- [ ] An existing non-empty company folder blocks the entire save.
- [ ] The missing or invalid company name prompts for manual entry.
- [ ] No Python Native Messaging dependency is required for the new bid-folder operations.

## Configuration and reliability

- [ ] Existing candidate records survive migration.
- [ ] Candidate profiles remain isolated.
- [ ] JSON records use stable IDs and schema versions.
- [ ] Existing prompt-file compatibility is preserved where needed.
- [ ] Configuration errors do not silently erase candidate data.
- [ ] Shared configuration access between the web app and extension is explicitly implemented and tested.
- [ ] The architecture supports future replacement of JSON repositories with database-backed repositories.

# 14. Final Design Decision

The application will be modernized incrementally around the existing multi-candidate source and resume-generation workflow.

The web application provides the full resume-tailoring experience. The Chrome extension provides a focused JD, CV, preview, candidate-information, and local-save workflow.

Candidate-assigned AI prompts and preferred document templates are separate, reusable concepts. The extension uses a user-selected bid root folder and protects existing company folders from accidental overwrites.

JSON remains the initial persistent data format under `config/`, with repository interfaces supporting future database migration.

The critical implementation constraint is to verify how the web application and extension share candidate and template configuration without a native host. Bid-folder access can be handled through explicit directory permissions, but shared configuration access must be designed separately rather than assumed.

The first implementation step is therefore a source audit, followed by the smallest set of changes needed to deliver the new experience without breaking the existing system.
