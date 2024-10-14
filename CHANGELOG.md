# Changelog

## [2.3.0]

### Added

- Improved branch change detection and handling in StatusBarService
- Immediate polling for build status after pushing changes
- Support for detecting and handling in-progress CI statuses
- Rate limit checking and warning for CI API requests
- Separate caching mechanisms for different repositories in CIService

### Changed

- Enhanced error handling and logging throughout the extension
- Optimized status bar updates to reduce unnecessary refreshes
- Improved handling of repository and branch switches
- Updated GitService to emit events on repository changes

### Improved

- More robust CI status polling with adaptive intervals
- Better caching strategy for CI build statuses
- Enhanced logging for easier debugging and troubleshooting
- Refined error messages and user feedback for CI operations

### Fixed

- Issues with status bar not updating correctly on branch changes
- Potential race conditions in simultaneous CI status checks

## [2.2.0]

### Added

- Support for GitLab repositories with nested group structures

### Fixed

- Improved URL parsing to correctly handle repositories with subgroups
- Fixed issue with extracting owner and repo from URLs containing credentials
- Enhanced compatibility with various Git remote URL formats (HTTPS, SSH, with/without credentials)

### Improved

- Robustness of repository information extraction from remote URLs
- Error handling and logging for repository parsing issues

## [2.1.0]

### Added

- Repository-specific build status tracking
- Event emitter for repository changes in GitService
- Separate caches for each repository in CIService
- Improved tag creation and pushing process with local verification

### Changed

- Enhanced status bar updates to reflect current repository status
- Optimized build status polling with immediate status updates
- Improved handling of repository switches

### Fixed

- Build status persistence across different repositories
- TypeScript errors in StatusBarService method signatures
- Error handling for tag pushing when switching repositories quickly

### Improved

- Code structure and organization for better maintainability
- Performance optimizations for status bar updates and CI status checks
- Error messages and user feedback for CI status checking

## [2.0.0]

- Added: Automatic detection of CI/CD system (GitHub Actions or GitLab CI)
- Added: Support for configuring multiple CI providers simultaneously
- Changed: CI provider configuration structure in settings
- Removed: Manual CI type selection from settings
- Improved: Error handling and user feedback for tag creation and pushing
- Fixed: Issue with tag creation and pushing synchronization
- Updated: Documentation to reflect new multi-provider support and configuration
- Added: New command "Refresh Branch Build Status" for manual refresh of build status
- Improved: Error handling and feedback for build status refresh
- Updated: Documentation to include information about the new refresh command

## [1.1.0]

- Changed: Restructure and optimize code for better maintainability

## [1.0.1]

- Fixed: Show unchangeable current version tag on no publishable commits

## [1.0.0]

- Initial release of Git Tag Release Tracker.
