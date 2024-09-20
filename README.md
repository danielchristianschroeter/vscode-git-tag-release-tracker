# Git Tag Release Tracker

This **Git Tag Release Tracker** Visual Studio Code extension allows you to track and manage your Git tags and releases directly from within your VSCode environment.

## Features

- **Automatic Detection**: The extension automatically detects your Git repository, branch, and the latest tags.
- **Status Bar Integration**: Displays the number of unreleased commits and the latest tag version in the VSCode status bar.
- **Tag Management**: Provides buttons to create major, minor, and patch tags directly from the status bar.
- **Initial Tag Creation**: Easily create an initial version tag (1.0.0) if no tags are present.
- **Compare Commits**: Open a compare link to view changes between the latest tag and current branch on GitHub/GitLab.
- **Ideal for CI/CD Workflows**: Perfect for integration into CI/CD workflows that will be triggered by tag pushes.

### Screenshots

![Status Bar Integration](images/status-bar.png)

## Requirements

Your current directory must contain a Git repository with a remote (such as GitHub or GitLab) configured.

## Extension Settings

This extension contributes the following settings:

- `gitTagReleaseTracker.defaultBranch`: Specifies the default branch used for release versioning (e.g., main, master, production). Default is `main`.

## Release Notes

### 1.0.0

- Initial release of Git Tag Release Tracker
