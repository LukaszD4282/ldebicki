const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");

const execFileAsync = promisify(execFile);
const JIRA_URL = "https://jira-eng-sjc12.cisco.com/jira";
const DESKTOP_REPO = "https://sqbu-github.cisco.com/CBABU/wxcc-desktop";
const CONFIG_REPO = `${DESKTOP_REPO}-release-config.git`;
const DESKTOP_GIT_REPO = `${DESKTOP_REPO}.git`;
const CDN_ENVIRONMENTS = [
  {
    name: "nonprod",
    buildInfoUrl:
      "https://wxcc-desktop-nonprod-cdn.ciscoccservice.com/build_info",
    releasesFile: "promotion-service/data/releases.json",
  },
  {
    name: "prod",
    buildInfoUrl: "https://wxcc.cisco.com/build_info",
    releasesFile: "promotion-service/data/releases_prod.json",
  },
];

let repositoriesPromise;
let repositoriesRefreshedAt = 0;

function parseSubmission(trigger) {
  const inputs = trigger?.attachmentAction?.inputs;
  if (!inputs || !["jira", "commits", "list"].includes(inputs.formType)) {
    return null;
  }

  const value = String(
    inputs.formType === "jira"
      ? inputs.jiraKey || ""
      : inputs.formType === "commits"
      ? inputs.commitSha || ""
      : inputs.buildVersion || ""
  ).trim();
  const normalized = inputs.formType === "jira" ? value.toUpperCase() : value;
  const isValid =
    inputs.formType === "jira"
      ? /^CX-\d+$/.test(normalized)
      : inputs.formType === "commits"
      ? /^[0-9a-f]{7,40}$/i.test(normalized)
      : /^[a-z0-9._-]{1,100}$/i.test(normalized);

  return {
    type: inputs.formType,
    value: normalized,
    isValid,
    error:
      inputs.formType === "jira"
        ? "Please enter a valid CX JIRA key, for example **CX-12345**."
        : inputs.formType === "commits"
        ? "Please enter a valid Git commit SHA (7-40 hexadecimal characters)."
        : "Please enter a valid CDN build version.",
  };
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 15000),
    });
  } catch (error) {
    if (error.name === "TimeoutError") error.code = "ETIMEDOUT";
    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      `HTTP ${response.status} from ${new URL(url).host}`
    );
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

function createJiraClient(options = {}) {
  const baseUrl = (
    options.jiraBaseUrl ||
    process.env.JIRA_BASE_URL ||
    JIRA_URL
  ).replace(/\/$/, "");
  const token =
    options.jiraToken || process.env.JIRA_PAT || process.env.JIRA_TOKEN;
  const get = options.requestJson || requestJson;

  return {
    baseUrl,
    get(endpoint, params = {}) {
      const url = new URL(`${baseUrl}${endpoint}`);
      Object.entries(params).forEach(([key, value]) =>
        url.searchParams.set(key, value)
      );
      return get(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    },
  };
}

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: Number(process.env.GIT_TIMEOUT_MS) || 120000,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function ensureRepository(directory, url) {
  if (!fs.existsSync(path.join(directory, ".git"))) {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    await git([
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      url,
      directory,
    ]);
  } else {
    await git([
      "-C",
      directory,
      "fetch",
      "--quiet",
      "--prune",
      "--tags",
      "--filter=blob:none",
      "origin",
    ]);
  }
}

async function ensureRepositories() {
  if (
    !repositoriesPromise ||
    Date.now() - repositoriesRefreshedAt > 5 * 60 * 1000
  ) {
    const cache = path.join(os.tmpdir(), "wxcc-cdn-lookup");
    const config = path.join(cache, "release-config");
    const desktop = path.join(cache, "wxcc-desktop");
    repositoriesPromise = Promise.all([
      ensureRepository(config, process.env.CDN_CONFIG_REPO_URL || CONFIG_REPO),
      ensureRepository(
        desktop,
        process.env.DESKTOP_REPO_URL || DESKTOP_GIT_REPO
      ),
    ])
      .then(() => {
        repositoriesRefreshedAt = Date.now();
        return { config, desktop };
      })
      .catch((error) => {
        repositoriesPromise = null;
        error.code = error.code || "EGIT";
        throw error;
      });
  }
  return repositoriesPromise;
}

async function readReleaseConfig(repository, file) {
  const { stdout } = await git([
    "-C",
    repository,
    "show",
    `origin/main:${file}`,
  ]);
  return JSON.parse(stdout);
}

function releaseTagTimestamp(tag) {
  const value = tag.match(/-(\d{14})\./)?.[1];
  if (!value) return null;
  return Date.parse(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(
      6,
      8
    )}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`
  );
}

async function resolveBuildCommit(repository, release) {
  try {
    const { stdout } = await git([
      "-C",
      repository,
      "rev-parse",
      `v${release.version}^{commit}`,
    ]);
    return stdout.trim();
  } catch (_) {
    const { stdout } = await git([
      "-C",
      repository,
      "tag",
      "--list",
      `${release.branch}-agentx-*`,
    ]);
    const rolloutAt = Date.parse(release.rolloutStart);
    const tag = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((name) => ({ name, at: releaseTagTimestamp(name) }))
      .filter((candidate) => candidate.at && candidate.at <= rolloutAt)
      .sort((a, b) => b.at - a.at)[0]?.name;

    if (!tag) return null;
    const result = await git([
      "-C",
      repository,
      "rev-parse",
      `${tag}^{commit}`,
    ]);
    return result.stdout.trim();
  }
}

async function activeReleases(options = {}) {
  const { config, desktop } = await ensureRepositories();
  const get = options.requestJson || requestJson;

  return (
    await Promise.all(
      CDN_ENVIRONMENTS.map(async (environment) => {
        const [active, configured] = await Promise.all([
          get(environment.buildInfoUrl),
          readReleaseConfig(config, environment.releasesFile),
        ]);
        const configuration = new Map(
          configured.releases.map((release) => [release.version, release])
        );

        return Promise.all(
          (active.releases || []).map(async (release) => {
            const details = configuration.get(release.version);
            if (!details) return null;
            const normalized = {
              environment: environment.name,
              version: release.version,
              branch: details.branch,
              rolloutStart: details["rollout-start"],
            };
            return {
              ...normalized,
              commit: await resolveBuildCommit(desktop, normalized),
            };
          })
        );
      })
    )
  )
    .flat()
    .filter((release) => release?.commit);
}

async function normalizeCommit(repository, sha) {
  try {
    const { stdout } = await git([
      "-C",
      repository,
      "rev-parse",
      "--verify",
      `${sha}^{commit}`,
    ]);
    return stdout.trim();
  } catch (error) {
    error.publicMessage = `I couldn't find commit \`${sha}\` in wxcc-desktop.`;
    throw error;
  }
}

async function isAncestor(repository, commit, buildCommit) {
  try {
    await git([
      "-C",
      repository,
      "merge-base",
      "--is-ancestor",
      commit,
      buildCommit,
    ]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function findBuilds(commits, options = {}) {
  const { desktop } = await ensureRepositories();
  const releases = await activeReleases(options);
  const normalizedCommits = await Promise.all(
    commits.map((commit) => normalizeCommit(desktop, commit))
  );
  const matches = [];

  for (const release of releases) {
    for (const commit of normalizedCommits) {
      if (await isAncestor(desktop, commit, release.commit)) {
        matches.push({ ...release, matchedCommit: commit });
        break;
      }
    }
  }

  return { commits: normalizedCommits, matches };
}

async function findCommitsByJiraKey(repository, jiraKey) {
  const pattern = `(^|[^A-Za-z0-9])${jiraKey}([^A-Za-z0-9]|$)`;
  const { stdout } = await git([
    "-C",
    repository,
    "log",
    "--all",
    "--format=%H",
    "--regexp-ignore-case",
    "--extended-regexp",
    `--grep=${pattern}`,
  ]);

  return stdout.trim().split("\n").filter(Boolean);
}

async function lookupCommitBuilds(commitSha, options) {
  if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
    const error = new Error("Invalid Git commit SHA");
    error.publicMessage =
      "Please enter a valid Git commit SHA (7-40 hexadecimal characters).";
    throw error;
  }

  const result = await findBuilds([commitSha], options);
  const commit = result.commits[0];
  const { desktop } = await ensureRepositories();
  const { stdout } = await git([
    "-C",
    desktop,
    "show",
    "-s",
    "--format=%s",
    commit,
  ]);
  const jiraKeys = [
    ...new Set(
      stdout.match(/\bCX-\d+\b/gi)?.map((key) => key.toUpperCase()) || []
    ),
  ];
  let relatedJira = null;

  if (jiraKeys.length) {
    const relatedCommits = [
      ...new Set(
        (
          await Promise.all(
            jiraKeys.map((key) => findCommitsByJiraKey(desktop, key))
          )
        ).flat()
      ),
    ];
    const related = await findBuilds(relatedCommits, options);

    if (related.matches.some((match) => match.matchedCommit !== commit)) {
      relatedJira = { keys: jiraKeys, matches: related.matches };
    }
  }

  return { commit, matches: result.matches, relatedJira };
}

async function lookupBuildCommits(buildVersion) {
  if (!/^[a-z0-9._-]{1,100}$/i.test(buildVersion)) {
    const error = new Error("Invalid CDN build version");
    error.publicMessage = "Please enter a valid CDN build version.";
    throw error;
  }

  const { config, desktop } = await ensureRepositories();
  const builds = [];

  for (const environment of CDN_ENVIRONMENTS) {
    const configured = await readReleaseConfig(
      config,
      environment.releasesFile
    );
    const index = configured.releases.findIndex(
      (release) => release.version.toLowerCase() === buildVersion.toLowerCase()
    );
    if (index < 0) continue;

    const details = configured.releases[index];
    const previousDetails = configured.releases[index + 1];
    const release = {
      environment: environment.name,
      version: details.version,
      branch: details.branch,
      rolloutStart: details["rollout-start"],
    };
    const previous = previousDetails && {
      environment: environment.name,
      version: previousDetails.version,
      branch: previousDetails.branch,
      rolloutStart: previousDetails["rollout-start"],
    };
    const commit = await resolveBuildCommit(desktop, release);
    const previousCommit =
      previous && (await resolveBuildCommit(desktop, previous));

    if (!commit) continue;
    const range = previousCommit ? `${previousCommit}..${commit}` : commit;
    const [{ stdout: countOutput }, { stdout: logOutput }] = await Promise.all([
      git(["-C", desktop, "rev-list", "--first-parent", "--count", range]),
      git([
        "-C",
        desktop,
        "log",
        "--first-parent",
        "--reverse",
        "--max-count=50",
        "--format=%H%x1f%s",
        range,
      ]),
    ]);
    const commits = logOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha, subject: subject.slice(0, 140) };
      });

    builds.push({
      environment: environment.name,
      version: release.version,
      previousVersion: previous?.version || null,
      total: Number(countOutput.trim()),
      commits,
    });
  }

  if (!builds.length) {
    const error = new Error("CDN build not found");
    error.publicMessage = `I couldn't find CDN build \`${buildVersion}\` in prod or nonprod.`;
    throw error;
  }
  return { buildVersion, builds };
}

async function lookupCxDeployment(jiraKey, options) {
  const key = String(jiraKey || "")
    .trim()
    .toUpperCase();
  if (!/^CX-\d+$/.test(key)) {
    const error = new Error("Invalid CX Jira key");
    error.publicMessage =
      "Please enter a valid CX JIRA key, for example **CX-12345**.";
    throw error;
  }

  const jira = createJiraClient(options);
  const issue = await jira.get(`/rest/api/2/issue/${key}`, {
    fields: "summary",
  });
  const development = await jira.get("/rest/dev-status/1.0/issue/detail", {
    issueId: issue.id,
    applicationType: "githube",
    dataType: "repository",
  });
  const linkedCommits = [
    ...new Set(
      (development.detail || [])
        .flatMap((detail) => detail.repositories || [])
        .filter((repository) => /wxcc-desktop/i.test(repository.name || ""))
        .flatMap((repository) => repository.commits || [])
        .filter((commit) =>
          String(commit.message || "")
            .toUpperCase()
            .includes(key)
        )
        .map((commit) => commit.id)
        .filter(Boolean)
    ),
  ];
  const { desktop } = await ensureRepositories();
  const historyCommits = await findCommitsByJiraKey(desktop, key);
  const commits = [...new Set([...linkedCommits, ...historyCommits])];
  const result = commits.length
    ? await findBuilds(commits, options)
    : { commits: [], matches: [] };

  return {
    key,
    url: `${jira.baseUrl}/browse/${key}`,
    summary: issue.fields.summary,
    commits: result.commits,
    matches: result.matches,
  };
}

function buildsFor(report, environment) {
  return [
    ...new Set(
      report.matches
        .filter((match) => match.environment === environment)
        .map((match) => match.version)
    ),
  ];
}

function formatBuilds(builds) {
  return builds.length
    ? builds.map((build) => `\`${build}\``).join(", ")
    : "not deployed";
}

function formatMatchedBuilds(matches, environment) {
  const seen = new Set();
  const builds = matches
    .filter((match) => match.environment === environment)
    .filter((match) => {
      if (seen.has(match.version)) return false;
      seen.add(match.version);
      return true;
    })
    .map(
      (match) =>
        `\`${match.version}\` via [\`${match.matchedCommit.slice(
          0,
          7
        )}\`](${DESKTOP_REPO}/commit/${match.matchedCommit})`
    );

  return builds.length ? builds.join(", ") : "not deployed";
}

function formatDeploymentReport(report) {
  const nonprod = buildsFor(report, "nonprod");
  const prod = buildsFor(report, "prod");
  const status =
    nonprod.length && prod.length
      ? "both prod and nonprod"
      : prod.length
      ? "prod only"
      : nonprod.length
      ? "nonprod only"
      : "neither prod nor nonprod";

  return [
    `**[${report.key}](${report.url}) — ${report.summary}**`,
    "",
    `- **CDN status:** ${status}`,
    `- **Nonprod builds:** ${formatMatchedBuilds(report.matches, "nonprod")}`,
    `- **Prod builds:** ${formatMatchedBuilds(report.matches, "prod")}`,
  ].join("\n");
}

function formatCommitBuildsReport(report) {
  const nonprod = buildsFor(report, "nonprod");
  const prod = buildsFor(report, "prod");
  const lines = [
    `**Commit [\`${report.commit.slice(0, 7)}\`](${DESKTOP_REPO}/commit/${
      report.commit
    }) — exact SHA deployment**`,
    "",
    `- **Nonprod builds:** ${formatBuilds(nonprod)}`,
    `- **Prod builds:** ${formatBuilds(prod)}`,
  ];

  if (report.relatedJira) {
    lines.push(
      "",
      `**Related Jira deployment (${report.relatedJira.keys.join(", ")})**`,
      "",
      "The Jira also appears in builds through other commit SHAs.",
      "",
      `- **Nonprod builds:** ${formatMatchedBuilds(
        report.relatedJira.matches,
        "nonprod"
      )}`,
      `- **Prod builds:** ${formatMatchedBuilds(
        report.relatedJira.matches,
        "prod"
      )}`
    );
  }

  return lines.join("\n");
}

function formatBuildCommitsReport(report) {
  const lines = [`**CDN build \`${report.buildVersion}\`**`];

  for (const build of report.builds) {
    lines.push(
      "",
      `**${build.environment[0].toUpperCase()}${build.environment.slice(1)}**${
        build.previousVersion
          ? ` — changes since \`${build.previousVersion}\``
          : ""
      }`
    );
    if (!build.commits.length) {
      lines.push("- No new commits from the preceding CDN build.");
    } else {
      lines.push(
        ...build.commits.map(
          (commit) =>
            `- [\`${commit.sha.slice(0, 7)}\`](${DESKTOP_REPO}/commit/${
              commit.sha
            }) — ${commit.subject}`
        )
      );
    }
    if (build.total > build.commits.length) {
      lines.push(`- _Showing 50 of ${build.total} commits._`);
    }
  }
  return lines.join("\n");
}

function formatLookupError(error, value) {
  if (error.publicMessage) return error.publicMessage;
  if ([401, 403].includes(error.statusCode)) {
    return `Jira rejected **${value}** (HTTP ${error.statusCode}). Configure \`JIRA_PAT\` and restart the bot.`;
  }
  if (error.statusCode === 404) {
    return `I couldn't find **${value}**, or your Jira account cannot view it.`;
  }
  if (error.code === "ENOENT") {
    return "The bot needs `git` installed to inspect CDN build commits.";
  }
  if (error.code === "EGIT" || error.cmd?.startsWith("git ")) {
    return "I couldn't read the wxcc-desktop CDN release repositories. Check Git access and try again.";
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
    return `I couldn't reach Jira or the CDN for **${value}**. Check VPN/network access.`;
  }
  return `I couldn't look up **${value}**. See the bot log for details.`;
}

module.exports = {
  parseSubmission,
  lookupCxDeployment,
  lookupCommitBuilds,
  lookupBuildCommits,
  formatDeploymentReport,
  formatCommitBuildsReport,
  formatBuildCommitsReport,
  formatLookupError,
};
