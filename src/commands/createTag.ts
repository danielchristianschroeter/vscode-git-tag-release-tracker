import * as vscode from "vscode";
import * as semver from "semver";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { handleError } from "../utils/errorHandler";
import { CIService } from "../services/ciService";
import { Logger } from "../utils/logger";

export async function createTag(
  type: "initial" | "major" | "minor" | "patch",
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string
) {
  let progressResolver: (() => void) | undefined;
  const progress = new Promise<void>(resolve => {
    progressResolver = resolve;
  });

  try {
    const currentBranch = await gitService.getCurrentBranch();
    if (currentBranch !== defaultBranch) {
      throw new Error(`You must be on the ${defaultBranch} branch to create a tag.`);
    }

    const latestTag = await gitService.getLatestTag();
    let newTag: string;

    if (type === "initial") {
      if (latestTag.latest) {
        throw new Error("Initial tag cannot be created as tags already exist.");
      }
      newTag = "1.0.0";
    } else {
      if (!latestTag.latest) {
        throw new Error("No existing tags found. Please create an initial tag first.");
      }

      const match = latestTag.latest.match(/^([^\d]*)(\d+\.\d+\.\d+)(.*)$/);
      if (!match) {
        throw new Error(`Invalid tag format: ${latestTag.latest}`);
      }

      const [, prefix, version, suffix] = match;
      const newVersion = semver.inc(version, type);
      if (!newVersion) {
        throw new Error(`Failed to increment version: ${version}`);
      }

      newTag = `${prefix}${newVersion}${suffix}`;
    }

    const ownerAndRepo = await gitService.getOwnerAndRepo();
    if (!ownerAndRepo) {
      throw new Error('Unable to determine owner and repo');
    }
    const { owner, repo } = ownerAndRepo;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating ${type} tag ${newTag} for ${owner}/${repo}`,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: "Creating tag locally...", increment: 20 });
          await gitService.createTagInternal(newTag);
          Logger.log(`Tag ${newTag} created locally. Waiting before push...`, 'INFO');
          
          progress.report({ message: "Preparing to push tag...", increment: 30 });
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds delay

          progress.report({ message: "Pushing tag to remote repository...", increment: 40 });
          try {
            await gitService.pushTag(newTag);
            progress.report({ message: "Tag pushed to remote repository...", increment: 50 });
          } catch (pushError) {
            Logger.log(`Error pushing tag ${newTag}: ${pushError}`, 'ERROR');
            vscode.window.showErrorMessage(`Failed to push tag ${newTag}. Please try again or push manually.`);
            return;
          }

          progress.report({ message: "Triggering UI and build status refresh...", increment: 70 });
          
          const multiRepoService = statusBarService.getMultiRepoService();
          const repoRoot = gitService.getRepoRoot();
          multiRepoService.invalidateCacheForRepo(repoRoot);

          // A short delay to allow the CI to pick up the new tag
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          await statusBarService.reloadEverything(true);

          progress.report({ message: "Tag creation process completed", increment: 100 });
        } catch (error) {
          Logger.log(`Error creating ${type} tag: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
          if (error instanceof Error && error.stack) {
            Logger.log(`Error stack: ${error.stack}`, 'ERROR');
          }
          handleError(error, `Error creating ${type} tag`);
          // Update UI even if an error occurs
          await statusBarService.reloadEverything(true);
        } finally {
          if (progressResolver) {
            progressResolver();
          }
        }
      }
    );
  } catch (error) {
    handleError(error, `Error preparing to create ${type} tag`);
    // Update UI even if an error occurs
    await statusBarService.reloadEverything(true);
    if (progressResolver) {
      progressResolver();
    }
  }

  return progress;
}
