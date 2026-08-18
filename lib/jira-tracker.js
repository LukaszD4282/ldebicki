const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const RELEASE_BRANCH_PREFIX = "wxcc-desktop-release";
const RELEASE_BRANCH_PATTERN = new RegExp(
  `^origin/${RELEASE_BRANCH_PREFIX}-([0-9]{2})-([0-9]{1,2})-([0-9]+)$`
);
const REPOSITORY_URL = process.env.JIRA_TRACKER_REPOSITORY_URL || "";
const REPOSITORY_CACHE_KEY = crypto
  .createHash("sha256")
  .update(REPOSITORY_URL)
  .digest("hex")
  .slice(0, 12);
const REPOSITORY_CACHE_ROOT = path.join(os.tmpdir(), "jira-tracker-cache");
const REPOSITORY_PATH = path.join(
  REPOSITORY_CACHE_ROOT,
  `jira-tracker-${REPOSITORY_CACHE_KEY}`
);
const REPOSITORY_REFRESH_INTERVAL_MS = 60 * 1000;
const BRANCH_CUT_UNCERTAINTY_DAYS = 4;
const JIRA_KEY_PATTERN_SOURCE = "[A-Za-z][A-Za-z0-9_]*-[0-9]+";
const JIRA_KEY_PATTERN = new RegExp(`^${JIRA_KEY_PATTERN_SOURCE}$`);
const RESULT_MODES = new Set(["all", "earliest"]);

let repositoryLastRefreshedAt = 0;
let repositoryQueue = Promise.resolve();

function redactRepositoryUrl(message) {
  return message.split(REPOSITORY_URL).join("<repository URL>");
}

function execute(command, args, options = {}) {
  const { env, ...execOptions } = options;

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        ...execOptions,
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(redactRepositoryUrl(stderr.trim() || error.message))
          );
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

function runGit(args) {
  return execute("git", ["-C", REPOSITORY_PATH, ...args]);
}

function ensurePrivateCacheRoot() {
  fs.mkdirSync(REPOSITORY_CACHE_ROOT, { recursive: true, mode: 0o700 });

  const cacheRoot = fs.lstatSync(REPOSITORY_CACHE_ROOT);

  if (cacheRoot.isSymbolicLink() || !cacheRoot.isDirectory()) {
    throw new Error("The Jira tracker cache root is not a safe directory.");
  }

  if (
    typeof process.getuid === "function" &&
    cacheRoot.uid !== process.getuid()
  ) {
    throw new Error("The Jira tracker cache root has a different owner.");
  }

  if (process.platform !== "win32" && (cacheRoot.mode & 0o077) !== 0) {
    fs.chmodSync(REPOSITORY_CACHE_ROOT, 0o700);
  }
}

function repositoryCacheExists() {
  if (!fs.existsSync(REPOSITORY_PATH)) {
    return false;
  }

  const repository = fs.lstatSync(REPOSITORY_PATH);

  if (repository.isSymbolicLink() || !repository.isDirectory()) {
    throw new Error("The Jira tracker cache is not a safe directory.");
  }

  if (
    typeof process.getuid === "function" &&
    repository.uid !== process.getuid()
  ) {
    throw new Error("The Jira tracker cache has a different owner.");
  }

  const gitDirectory = path.join(REPOSITORY_PATH, ".git");

  if (!fs.existsSync(gitDirectory)) {
    throw new Error(
      `The Jira tracker cache at ${REPOSITORY_PATH} is not a Git repository.`
    );
  }

  const gitMetadata = fs.lstatSync(gitDirectory);

  if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
    throw new Error("The Jira tracker cache has unsafe Git metadata.");
  }

  return true;
}

async function verifyRepositoryRemote() {
  const originUrl = await runGit(["remote", "get-url", "origin"]);

  if (originUrl !== REPOSITORY_URL) {
    throw new Error(
      "The Jira tracker cache points to a different origin repository."
    );
  }
}

async function cloneRepository() {
  const temporaryPath = fs.mkdtempSync(
    path.join(REPOSITORY_CACHE_ROOT, "clone-")
  );

  try {
    await execute(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--origin",
        "origin",
        "--",
        REPOSITORY_URL,
        temporaryPath,
      ],
      { timeout: 300000 }
    );

    try {
      fs.renameSync(temporaryPath, REPOSITORY_PATH);
    } catch (error) {
      if (!fs.existsSync(path.join(REPOSITORY_PATH, ".git"))) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
}

async function refreshRepository() {
  ensurePrivateCacheRoot();
  const cacheExists = repositoryCacheExists();

  if (!cacheExists) {
    await cloneRepository();
    repositoryCacheExists();
    await verifyRepositoryRemote();
    return;
  }

  await verifyRepositoryRemote();
  await runGit(["fetch", "origin", "--prune", "--quiet"]);
}

async function prepareRepository() {
  ensurePrivateCacheRoot();
  const cacheExists = repositoryCacheExists();

  if (
    cacheExists &&
    Date.now() - repositoryLastRefreshedAt < REPOSITORY_REFRESH_INTERVAL_MS
  ) {
    return;
  }

  await refreshRepository();
  repositoryLastRefreshedAt = Date.now();
}

function useRepository(operation) {
  const queuedOperation = repositoryQueue.then(async () => {
    await prepareRepository();
    return operation();
  });

  repositoryQueue = queuedOperation.then(
    () => undefined,
    () => undefined
  );

  return queuedOperation;
}

function isValidJiraKey(jiraKey) {
  return typeof jiraKey === "string" && JIRA_KEY_PATTERN.test(jiraKey);
}

function getJiraCommitPattern(jiraKey) {
  return `(^|[^A-Z0-9_])${jiraKey}([^A-Z0-9]|$)`;
}

async function findMatchingCommits(
  references,
  jiraKey,
  { firstOnly = false, format = "%H" } = {}
) {
  if (!references.length) {
    return [];
  }

  const output = await runGit([
    "log",
    ...(firstOnly ? ["--max-count=1"] : []),
    `--format=${format}`,
    "--regexp-ignore-case",
    "--extended-regexp",
    `--grep=${getJiraCommitPattern(jiraKey)}`,
    ...references,
    "--",
  ]);

  return output ? [...new Set(output.split("\n").filter(Boolean))] : [];
}

async function getReleaseBranches() {
  const output = await runGit([
    "branch",
    "--remotes",
    "--list",
    `origin/${RELEASE_BRANCH_PREFIX}-*`,
    "--format=%(refname:short)",
  ]);

  return output
    ? output
        .split("\n")
        .filter(Boolean)
        .map(parseReleaseBranch)
        .filter(Boolean)
        .sort(compareReleases)
    : [];
}

async function getJiraReleaseBranches(releases, jiraKey) {
  const releaseBranches = releases.map(({ branch }) => branch);
  const matchingCommits = await findMatchingCommits(releaseBranches, jiraKey);

  if (!matchingCommits.length) {
    return [];
  }

  const output = await runGit([
    "for-each-ref",
    "--format=%(refname:short)",
    ...matchingCommits.map((commit) => `--contains=${commit}`),
    `refs/remotes/origin/${RELEASE_BRANCH_PREFIX}-*`,
  ]);
  const branchesContainingJira = new Set(
    output ? output.split("\n").filter(Boolean) : []
  );

  return releases.filter(({ branch }) => branchesContainingJira.has(branch));
}

function parseReleaseBranch(branch) {
  const match = branch.match(RELEASE_BRANCH_PATTERN);

  if (!match) {
    return undefined;
  }

  const release = {
    branch,
    year: Number(match[1]),
    month: Number(match[2]),
    build: Number(match[3]),
  };

  return release.month >= 1 && release.month <= 12 ? release : undefined;
}

function compareReleases(first, second) {
  return (
    first.year - second.year ||
    first.month - second.month ||
    first.build - second.build
  );
}

function formatBranchName(branch) {
  return branch.replace(/^origin\//, "");
}

function getOrdinalSuffix(day) {
  const lastTwoDigits = day % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return "th";
  }

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatCalendarDate(calendarDate) {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const year = calendarDate.slice(0, 4);
  const month = months[Number(calendarDate.slice(4, 6)) - 1];
  const day = Number(calendarDate.slice(6, 8));

  return `${day}${getOrdinalSuffix(day)} of ${month} ${year}`;
}

function isValidCalendarDate(calendarDate) {
  const year = Number(calendarDate.slice(0, 4));
  const month = Number(calendarDate.slice(4, 6));
  const day = Number(calendarDate.slice(6, 8));
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  return (
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
  );
}

function getCalendarEventValue(eventLines, propertyName) {
  const propertyLine = eventLines.find((line) =>
    new RegExp(`^${propertyName}(?:;[^:]*)?:`, "i").test(line)
  );

  return propertyLine
    ? propertyLine.slice(propertyLine.indexOf(":") + 1).trim()
    : "";
}

function normalizeReleaseName(summary, eventType) {
  const suffix =
    eventType === "branchCut"
      ? /\s+branch\s+cut$/i
      : /\s+production\s+deploy$/i;

  return summary
    .replace(/^wxcc\s+/i, "")
    .replace(suffix, "")
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

function parseReleaseCalendarEvents(calendarData) {
  const unfoldedCalendarData = calendarData.replace(/\r?\n[ \t]/g, "");
  const calendarEvents =
    unfoldedCalendarData.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  const releaseEvents = [];

  for (const calendarEvent of calendarEvents) {
    const eventLines = calendarEvent.split(/\r?\n/);
    const categories = getCalendarEventValue(eventLines, "CATEGORIES")
      .split(",")
      .map((category) => category.trim().toLowerCase());
    const startDate = getCalendarEventValue(eventLines, "DTSTART").slice(0, 8);
    const summary = getCalendarEventValue(eventLines, "SUMMARY");
    let eventType;

    if (categories.includes("branch cut")) {
      eventType = "branchCut";
    } else if (categories.includes("production deploy")) {
      eventType = "productionDeploy";
    }

    if (
      eventType &&
      summary &&
      /^\d{8}$/.test(startDate) &&
      isValidCalendarDate(startDate)
    ) {
      releaseEvents.push({
        date: startDate,
        releaseName: normalizeReleaseName(summary, eventType),
        type: eventType,
      });
    }
  }

  return releaseEvents.sort((first, second) =>
    first.date.localeCompare(second.date)
  );
}

function getCalendarDayDifference(firstDate, secondDate) {
  const toUtcTime = (calendarDate) =>
    Date.UTC(
      Number(calendarDate.slice(0, 4)),
      Number(calendarDate.slice(4, 6)) - 1,
      Number(calendarDate.slice(6, 8))
    );

  return Math.round(
    (toUtcTime(secondDate) - toUtcTime(firstDate)) / (24 * 60 * 60 * 1000)
  );
}

function findCalendarReleaseEstimate(calendarData, commitDate) {
  const releaseEvents = parseReleaseCalendarEvents(calendarData);
  const branchCuts = releaseEvents.filter(({ type }) => type === "branchCut");
  const productionDeploys = releaseEvents.filter(
    ({ type }) => type === "productionDeploy"
  );
  const schedules = branchCuts
    .map((branchCut) => {
      const productionDeploy = productionDeploys.find(
        ({ date, releaseName }) =>
          releaseName === branchCut.releaseName && date >= branchCut.date
      );

      return productionDeploy ? { branchCut, productionDeploy } : undefined;
    })
    .filter(Boolean);
  const scheduleIndex = schedules.findIndex(
    ({ branchCut }) => branchCut.date >= commitDate
  );

  if (scheduleIndex === -1) {
    const previousSchedule = [...schedules]
      .reverse()
      .find(({ branchCut }) => branchCut.date < commitDate);
    const nextProductionDeploy = previousSchedule
      ? productionDeploys.find(
          ({ date }) =>
            date >= commitDate && date > previousSchedule.productionDeploy.date
        )
      : undefined;

    return nextProductionDeploy
      ? {
          primarySchedule: { productionDeploy: nextProductionDeploy },
          isWithinUncertaintyWindow: false,
        }
      : undefined;
  }

  const primarySchedule = schedules[scheduleIndex];
  const daysBeforeBranchCut = getCalendarDayDifference(
    commitDate,
    primarySchedule.branchCut.date
  );
  const isWithinUncertaintyWindow =
    daysBeforeBranchCut >= 0 &&
    daysBeforeBranchCut <= BRANCH_CUT_UNCERTAINTY_DAYS;

  if (!isWithinUncertaintyWindow) {
    return { primarySchedule, isWithinUncertaintyWindow };
  }

  const nextSchedule = schedules[scheduleIndex + 1];
  const nextProductionDeploy = nextSchedule
    ? nextSchedule.productionDeploy
    : productionDeploys.find(
        ({ date }) => date > primarySchedule.productionDeploy.date
      );

  return {
    primarySchedule,
    isWithinUncertaintyWindow,
    alternateSchedule: nextProductionDeploy
      ? {
          branchCut: nextSchedule?.branchCut,
          productionDeploy: nextProductionDeploy,
        }
      : undefined,
  };
}

async function getCalendarReleaseEstimate(commitDate) {
  const configuredCalendarUrl = process.env.CONFLUENCE_CALENDAR_ICAL_URL;

  if (!configuredCalendarUrl) {
    console.warn("CONFLUENCE_CALENDAR_ICAL_URL is not configured.");
    return undefined;
  }

  try {
    const response = await fetch(configuredCalendarUrl);

    if (!response.ok) {
      throw new Error(`Calendar request failed with status ${response.status}`);
    }

    const calendarData = await response.text();
    const releaseEstimate = findCalendarReleaseEstimate(
      calendarData,
      commitDate
    );

    if (releaseEstimate) {
      console.log(
        `Calendar release estimate found for main commit date ${commitDate}.`
      );
    } else {
      console.warn(
        `No complete branch-cut and production-deploy schedule was found after ${commitDate}.`
      );
    }

    return releaseEstimate;
  } catch (error) {
    console.error(`Unable to retrieve Confluence calendar: ${error.message}`);
    return undefined;
  }
}

function formatCalendarReleaseEstimate(jiraKey, releaseEstimate) {
  const { primarySchedule, isWithinUncertaintyWindow, alternateSchedule } =
    releaseEstimate;
  let message = `${jiraKey} is expected to be included in the next release branch cut`;

  if (primarySchedule.branchCut) {
    message += ` on ${formatCalendarDate(primarySchedule.branchCut.date)}`;
  }

  message += ` and as is schedules to start production deployment on ${formatCalendarDate(
    primarySchedule.productionDeploy.date
  )}.`;

  if (!isWithinUncertaintyWindow) {
    return message;
  }

  message += ` Because its matching main commit was made within ${BRANCH_CUT_UNCERTAINTY_DAYS} days of that branch cut, it may instead appear on the next release branch cut`;

  if (alternateSchedule?.branchCut) {
    message += ` on ${formatCalendarDate(alternateSchedule.branchCut.date)}`;
  }

  if (alternateSchedule?.productionDeploy) {
    message += ` and will be scheduled for production deployment on ${formatCalendarDate(
      alternateSchedule.productionDeploy.date
    )}`;
  }

  return `${message}.`;
}

function estimateReleaseBranch(releases) {
  const currentDate = new Date();
  let estimatedYear = currentDate.getFullYear() % 100;
  let estimatedMonth = currentDate.getMonth() + 1;

  if (releases.length) {
    const newestRelease = releases[releases.length - 1];
    const newestMonthCount = releases.filter(
      ({ year, month }) =>
        year === newestRelease.year && month === newestRelease.month
    ).length;

    estimatedYear = newestRelease.year;
    estimatedMonth = newestRelease.month;

    if (newestMonthCount >= 2) {
      if (estimatedMonth === 12) {
        estimatedYear = (estimatedYear + 1) % 100;
        estimatedMonth = 1;
      } else {
        estimatedMonth += 1;
      }
    }
  }

  return `${RELEASE_BRANCH_PREFIX}-${String(estimatedYear).padStart(
    2,
    "0"
  )}-${String(estimatedMonth).padStart(2, "0")}`;
}

async function runJiraTracker(jiraKey, resultMode = "all") {
  if (!isValidJiraKey(jiraKey)) {
    throw new Error(`Invalid Jira key: ${jiraKey}`);
  }

  if (!RESULT_MODES.has(resultMode)) {
    throw new Error(`Invalid result mode: ${resultMode}`);
  }

  const normalizedJiraKey = jiraKey.toUpperCase();

  return useRepository(async () => {
    const releases = await getReleaseBranches();
    const jiraReleases = await getJiraReleaseBranches(
      releases,
      normalizedJiraKey
    );

    if (jiraReleases.length) {
      const releasesToDisplay =
        resultMode === "earliest" ? jiraReleases.slice(0, 1) : jiraReleases;

      return `${normalizedJiraKey} was found in the commit history of:\n${releasesToDisplay
        .map(({ branch }) => formatBranchName(branch))
        .join("\n")}`;
    }

    const mainCommitDates = await findMatchingCommits(
      ["origin/main"],
      normalizedJiraKey,
      { firstOnly: true, format: "%cs" }
    );

    if (!mainCommitDates.length) {
      return `${normalizedJiraKey} has not been found in the commit history of main.`;
    }

    const commitDate = mainCommitDates[0].replaceAll("-", "");
    const calendarReleaseEstimate = await getCalendarReleaseEstimate(
      commitDate
    );

    if (calendarReleaseEstimate) {
      return `${normalizedJiraKey} was found in the commit history of main but not on a release branch.\n${formatCalendarReleaseEstimate(
        normalizedJiraKey,
        calendarReleaseEstimate
      )}`;
    }

    const estimatedReleaseBranch = estimateReleaseBranch(releases);

    return `${normalizedJiraKey} was found in the commit history of main but not on a release branch.\nEstimated release branch is the next branch for ${estimatedReleaseBranch}.`;
  });
}

module.exports = {
  isValidJiraKey,
  runJiraTracker,
};
