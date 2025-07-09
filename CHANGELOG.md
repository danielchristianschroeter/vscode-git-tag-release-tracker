# Changelog

## [3.0.0]

### Added

- **Multi-Repo Dashboard**: The hover-based dashboard shows an aggregated view of every Git repository in your workspace, including branch, tag, build status, unreleased and unmerged commit counts.
- **Hover-Based UI** with a rich Markdown table and one-click action buttons.
- **“Compare” Action**: Quick links to GitHub/GitLab compare pages for tags or branches.
- Loading indicator during repository detection and data fetching for instant feedback.
- Build status indicators for both branches and tags with clickable links to the CI/CD pipeline run.
- Version increment buttons (Major, Minor, Patch) that preserve existing prefixes/suffixes.
- Better error handling and user feedback for CI/CD status fetching.
- **Manual Refresh Command**: Added `Git Tag Release Tracker: Refresh Dashboard` to force a complete data refresh.

### Changed

- **Major Architectural Refactoring**: Core services (`GitService`, `CIService`, `StatusBarService`) are now instantiated per repository, enabling true multi-repo support and improved performance.
- **UI Overhaul**: The status bar has been simplified to a single aggregated item; all details are now in the hover dashboard.
- Simplified and icon-driven UI for improved readability, replacing inline text with tooltips where appropriate.
- Reduced debounce delays for snappier UI updates when switching files or branches.

### Fixed

- Resolved startup error that incorrectly reported "No Git repositories found".
- Fixed compare link generation on Windows.
- Restored version increment buttons (Major, Minor, Patch) in the hover menu.
- Corrected unmerged commit count calculation to compare against remote branches.
- Improved error handling and user feedback when generating compare URLs.
- Enhanced hover UI formatting, explanatory text, and added clarifications that version increments preserve prefixes/suffixes and when a version tag can be created.
- Repository list is now sorted alphabetically and tag actions correctly target the repository of the currently active file.

## [2.4.5]

### Fixed

- Fixed unmerged commits display by ensuring comparisons are made against the remote `origin` default branch instead of the local branch state, providing more accurate commit count information.
- Corrected compare URL generation to remove the `origin/` prefix from branch names, ensuring proper GitHub/GitLab compare links.
- Improved test suite stability by refactoring extension initialization and fixing test environment setup issues.
- Enhanced code maintainability by splitting `extension.ts` into smaller, focused modules (`globals.ts`, `servicesManager.ts`, `commandManager.ts`).

## [2.4.4]

## Fixed

- Refactor Git repository detection logic to improve accuracy and clarity in status updates, adding a method to find the Git root directory.

## [2.4.3]

### Fixed

- Corrected the handling of GitHub workflow statuses to ensure alignment with GitHub's allowed status values, improving the accuracy of status displays in the status bar.
- Resolved an issue where the latest tags were not being fetched correctly after switching branches, ensuring that the status bar reflects the most recent tag information.

## [2.4.2]

### Fixed

- Enhanced handling for directories that are not Git repositories, eliminating unnecessary error notifications.

## [2.4.1]

### Added

- Implemented immediate validation of CI provider configuration upon changes to settings, ensuring users receive timely feedback on configuration issues.

### Fixed

- Resolved issues with CI provider configuration not being recognized until the extension was restarted.
- Improved error handling for invalid CI provider configurations, providing clearer messages to users.

## [2.4.0]

### Added

- Implemented caching for redundant requests to improve overall performance.

### Fixed

- Improved logic in the `refreshAfterPush` method to ensure the status bar reflects the latest state of the repository after a push.
- Enhanced status bar to display the correct data for the selected repository/branch.
- Removed unnecessary and annoying error notifications.

### Miscellaneous

- Updated README with new information and screenshots.
- Improved overall code structure and readability.

## [2.3.0]

### Added

- Improved branch change detection and handling in `StatusBarService`.
- Immediate polling for build status after pushing changes.
- Support for detecting and handling in-progress CI statuses.
- Rate limit checking and warning for CI API requests.
- Separate caching mechanisms for different repositories in `CIService`.

### Changed

- Enhanced error handling and logging throughout the extension.
- Optimized status bar updates to reduce unnecessary refreshes.
- Improved handling of repository and branch switches.
- Updated `GitService` to emit events on repository changes.

### Improved

- More robust CI status polling with adaptive intervals.
- Better caching strategy for CI build statuses.
- Enhanced logging for easier debugging and troubleshooting.
- Refined error messages and user feedback for CI operations.

### Fixed

- Issues with the status bar not updating correctly on branch changes.
- Potential race conditions in simultaneous CI status checks.

## [2.2.0]

### Added

- Support for GitLab repositories with nested group structures.

### Fixed

- Improved URL parsing to correctly handle repositories with subgroups.
- Fixed issue with extracting owner and repo from URLs containing credentials.
- Enhanced compatibility with various Git remote URL formats (HTTPS, SSH, with/without credentials).

### Improved

- Robustness of repository information extraction from remote URLs.
- Error handling and logging for repository parsing issues.

## [2.1.0]

### Added

- Repository-specific build status tracking.
- Event emitter for repository changes in `GitService`.
- Separate caches for each repository in `CIService`.
- Improved tag creation and pushing process with local verification.

### Changed

- Enhanced status bar updates to reflect the current repository status.
- Optimized build status polling with immediate status updates.
- Improved handling of repository switches.

### Fixed

- Build status persistence across different repositories.
- TypeScript errors in `StatusBarService` method signatures.
- Error handling for tag pushing when switching repositories quickly.

### Improved

- Code structure and organization for better maintainability.
- Performance optimizations for status bar updates and CI status checks.
- Error messages and user feedback for CI status checking.

## [2.0.0]

### Added

- Automatic detection of CI/CD system (GitHub Actions or GitLab CI).
- Support for configuring multiple CI providers simultaneously.

### Changed

- CI provider configuration structure in settings.

### Removed

- Manual CI type selection from settings.

### Improved

- Error handling and user feedback for tag creation and pushing.
- Documentation to reflect new multi-provider support and configuration.
- Error handling and feedback for build status refresh.

### Fixed

- Issue with tag creation and pushing synchronization.
- Updated documentation to include information about the new refresh command.

## [1.1.0]

### Changed

- Restructured and optimized code for better maintainability.

## [1.0.1]

### Fixed

- Show unchangeable current version tag on no publishable commits.

## [1.0.0]

- Initial release of Git Tag Release Tracker.
