# Multi-Repo Dashboard Implementation Plan

This plan outlines the tasks required to implement the Multi-Repo Dashboard feature, including commit counts, automated merge requests, and optional LLM integration.

## 1. Foundational Setup

- **Task 1.1: Create a new `multiRepo` command.**
  - This command will open a new webview panel displaying the dashboard.
- **Task 1.2: Design the webview UI.**
  - Create a table layout with columns for:
    - Repository Name
    - Current Branch
    - Latest Tag
    - Unreleased Commits
    - Unmerged Commits
    - CI Status
- **Task 1.3: Implement the basic webview panel.**
  - Create the HTML structure and basic CSS for the dashboard.

## 2. Data Fetching and Display

- **Task 2.1: Create a `MultiRepoService`.**
  - This service will be responsible for gathering data from all repositories in the workspace.
- **Task 2.2: Implement data fetching logic.**
  - The `MultiRepoService` will use the existing `GitService` and `CIService` to fetch the required data for each repository.
- **Task 2.3: Implement data caching.**
  - Cache the fetched data to improve performance and avoid hitting API rate limits.
- **Task 2.4: Display the data in the webview.**
  - Populate the dashboard table with the fetched data.

## 3. Commit Counts

- **Task 3.1: Add commit count columns to the dashboard.**
  - Add columns for "Unreleased Commits" and "Unmerged Commits" to the table.
- **Task 3.2: Implement commit count logic.**
  - The `MultiRepoService` will use the `GitService` to calculate the commit counts for each repository.
- **Task 3.3: Display the commit counts.**
  - Show the commit counts in the dashboard table.

## 4. Automated Merge Requests

- **Task 4.1: Add a "Create MR" button to the dashboard.**
  - Add a button to each row of the table that will trigger the merge request creation process.
- **Task 4.2: Implement the merge request creation logic.**
  - When the "Create MR" button is clicked, the extension will:
    - Create a new merge request in the corresponding repository.
    - Pre-fill the title and description with relevant information.
- **Task 4.3: Add a "Create All MRs" button.**
  - Add a button to the top of the dashboard that will create merge requests for all repositories with unmerged commits.

## 5. LLM Integration

- **Task 5.1: Create a generic LLM service.**
  - This service will provide a common interface for all LLM providers.
- **Task 5.2: Add settings to configure LLM providers.**
  - Users will be able to select their preferred provider and enter their API keys.
- **Task 5.3: Implement a Gemini client.**
  - This will be the first client to implement the LLM service interface.
- **Task 5.4: Implement clients for other LLM providers.**
  - This will allow for the easy addition of other providers in the future.
- **Task 5.5: Generate merge request title and descriptions using the selected LLM provider.**
  - The LLM service will be used to generate the descriptions, regardless of the selected provider.

## 6. Testing

- **Task 6.1: Write unit tests for the `MultiRepoService`.**
  - Test the data fetching, caching, and commit count logic.
- **Task 6.2: Write unit tests for the merge request creation logic.**
  - Test the merge request creation process, including the pre-filling of the title and description.
- **Task 6.3: Write integration tests for the dashboard.**
  - Test the entire workflow, from opening the dashboard to creating a merge request.
- **Task 6.4: Write tests for the LLM integration.**
  - Test the generic LLM service and the individual clients.

## 7. Documentation

- **Task 7.1: Update the README.**
  - Add a section on the Multi-Repo Dashboard, explaining how to use it and its features.
- **Task 7.2: Update the CHANGELOG.**
  - Add an entry for the new feature.
