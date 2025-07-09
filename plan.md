# Refined Multi-Repo Dashboard Implementation Plan

This plan outlines the tasks required to implement the Multi-Repo Dashboard feature. It prioritizes architectural refactoring to support multiple repositories and implements a concise, hover-based UI on the status bar, as requested.

## 1. Core Architectural Refactoring

- **Task 1.1: Create `WorkspaceService`.** (Completed)
- **Task 1.2: Refactor `GitService` for Multi-Repo.** (Completed)
- **Task 1.3: Refactor `CIService` for Multi-Repo.** (Completed)
- **Task 1.4: Update `servicesManager.ts`.** (Completed)

## 2. Status Bar and Hover UI

- **Task 2.1: Enhance `StatusBarService`.** (Completed)
- **Task 2.2: Implement `MultiRepoHoverProvider`.** (Completed, as part of `StatusBarService`)
- **Task 2.3: Design the Hover UI.** (Completed)

## 3. Data Fetching and Display

- **Task 3.1: Create `MultiRepoService`.** (Completed)
- **Task 3.2: Implement Data Fetching and Caching.** (Completed)
- **Task 3.3: Display Data in Hover.** (Completed)

## 4. Core Feature Implementation

- **Task 4.1: Implement Commit Counts.** (Completed)
- **Task 4.2: Implement Actions from Hover UI.** (Completed)
- **Task 4.3: Enhance MR Creation with LLM.** (Deferred)
  - When a "Create MR" link is activated, the `LLMService` will be used to automatically generate a title and description for the merge request.
  - This provides a seamless, one-click process to create a well-documented merge request.

## 5. LLM Integration (Deferred)

- **Task 5.1: Create a generic `LLMService`.** (Deferred)
  - This service will provide a common interface for various LLM providers, responsible for generating text based on commit messages.
- **Task 5.2: Add Configuration Settings.** (Deferred)
  - Allow users to configure their preferred LLM provider and API keys in the settings.

## 6. Testing

- **Task 6.1: Write Unit Tests for New Services.** (Completed)
  - Tests for MultiRepoService
  - Tests for loading indicator in StatusBarService
  - Tests for build status integration in CIService
  - Tests for fixed unmerged commit count calculation in GitService
- **Task 6.2: Update Existing Unit Tests.** (Completed)
  - Updated tests to account for new features and fixed bugs
  - Fixed test assertions to match the new UI elements and behavior
- **Task 6.3: Write Integration Tests for Hover UI.** (Completed)
  - Tests for hover UI with different repository states
  - Tests for build status indicators and clickable links
- **Task 6.4: Write Tests for LLM Integration.** (Deferred)

## 7. Documentation

- **Task 7.1: Update `README.md`.** (Completed)
- **Task 7.2: Update `CHANGELOG.md`.** (Completed)

## 8. Bug Fixes

- **Task 8.1: Fix repository detection at startup.** (Completed)
  - Added loading indicator during repository detection
  - Fixed "No git repositories found" message showing incorrectly
- **Task 8.2: Fix Compare link functionality on Windows.** (Completed)
  - Fixed URI handling for Windows paths
- **Task 8.3: Fix version increment buttons in hover menu.** (Completed)
  - Restored Major, Minor, Patch buttons
  - Added clear explanation that version increments preserve prefixes/suffixes
- **Task 8.4: Fix unmerged commit count calculation.** (Completed)
  - Updated to properly compare with remote branches
  - Added tests to verify the fix
