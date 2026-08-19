//Webex Bot Starter - featuring the webex-node-bot-framework - https://www.npmjs.com/package/webex-node-bot-framework
require("dotenv").config();
var framework = require("webex-node-bot-framework");
var webhook = require("webex-node-bot-framework/webhook");
var express = require("express");
var bodyParser = require("body-parser");
var deploymentFunctions = require("./lib/deployment-functions");
var jiraTrackingFunctions = require("./lib/jira-tracker");
var parseSubmission = deploymentFunctions.parseSubmission;
var lookupCxDeployment = deploymentFunctions.lookupCxDeployment;
var lookupCommitBuilds = deploymentFunctions.lookupCommitBuilds;
var lookupBuildCommits = deploymentFunctions.lookupBuildCommits;
var lookupBranchCommits = deploymentFunctions.lookupBranchCommits;
var formatDeploymentReport = deploymentFunctions.formatDeploymentReport;
var formatCommitBuildsReport = deploymentFunctions.formatCommitBuildsReport;
var formatBuildCommitsReport = deploymentFunctions.formatBuildCommitsReport;
var formatBranchCommitsReport = deploymentFunctions.formatBranchCommitsReport;
var formatLookupError = deploymentFunctions.formatLookupError;
var isValidJiraKey = jiraTrackingFunctions.isValidJiraKey;
var runJiraTracker = jiraTrackingFunctions.runJiraTracker;
var app = express();
app.use(bodyParser.json());
app.use(express.static("images"));

const config = {
  token: process.env.BOTTOKEN,
};

// Only pass the webhook URL and port if it has been set in the environment
if (process.env.WEBHOOKURL && process.env.PORT) {
  config.webhookUrl = process.env.WEBHOOKURL;
  config.port = process.env.PORT;
}

// init framework
var framework = new framework(config);
framework.start();
console.log("Starting framework, please wait...");

framework.on("initialized", () => {
  console.log("framework is all fired up! [Press CTRL-C to quit]");
});

// A spawn event is generated when the framework finds a space with your bot in it
// If actorId is set, it means that user has just added your bot to a new space
// If not, the framework has discovered your bot in an existing space
framework.on("spawn", (bot, id, actorId) => {
  if (!actorId) {
    // don't say anything here or your bot's spaces will get
    // spammed every time your server is restarted
    console.log(
      `While starting up, the framework found our bot in a space called: ${bot.room.title}`
    );
  } else {
    // When actorId is present it means someone added your bot got added to a new space
    // Lets find out more about them..
    var msg =
      "You can say `help` to get the list of words I am able to respond to.";
    bot.webex.people
      .get(actorId)
      .then((user) => {
        msg = `Hello there ${user.displayName}. ${msg}`;
      })
      .catch((e) => {
        console.error(
          `Failed to lookup user details in framwork.on("spawn"): ${e.message}`
        );
        msg = `Hello there. ${msg}`;
      })
      .finally(() => {
        // Say hello, and tell users what you do!
        if (bot.isDirect) {
          bot.say("markdown", msg);
        } else {
          let botName = bot.person.displayName;
          msg += `\n\nDon't forget, in order for me to see your messages in this group space, be sure to *@mention* ${botName}.`;
          bot.say("markdown", msg);
        }
      });
  }
});

// Implementing a framework.on('log') handler allows you to capture
// events emitted from the framework.  Its a handy way to better understand
// what the framework is doing when first getting started, and a great
// way to troubleshoot issues.
// You may wish to disable this for production apps
framework.on("log", (msg) => {
  console.log(msg);
});

function createLookupForm(options) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.0",
    body: [
      {
        type: "TextBlock",
        text: options.title,
        weight: "Bolder",
        size: "Large",
        color: "Accent",
      },
      {
        type: "TextBlock",
        text: options.description,
        wrap: true,
        isSubtle: true,
        spacing: "Small",
      },
      {
        type: "Container",
        style: "emphasis",
        spacing: "Medium",
        items: [
          {
            type: "TextBlock",
            text: options.label,
            weight: "Bolder",
            wrap: true,
          },
          {
            type: "Input.Text",
            id: options.inputId,
            placeholder: options.placeholder,
            spacing: "Small",
          },
          {
            type: "TextBlock",
            text: options.hint,
            size: "Small",
            isSubtle: true,
            wrap: true,
            spacing: "Small",
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: options.actionTitle,
        data: { formType: options.formType },
      },
    ],
  };
}

const commitsForm = createLookupForm({
  title: "Find a commit",
  description: "See which nonprod and prod CDN builds contain a Git commit.",
  label: "Commit SHA",
  inputId: "commitSha",
  placeholder: "e.g. cb519c7",
  hint: "Enter 7 to 40 hexadecimal characters.",
  actionTitle: "Find CDN builds",
  formType: "commits",
});

const jiraForm = createLookupForm({
  title: "Check a Jira deployment",
  description: "See whether a CX Jira is deployed to nonprod, prod, or both.",
  label: "CX Jira key",
  inputId: "jiraKey",
  placeholder: "e.g. CX-12345",
  hint: "Only CX Jira keys are supported.",
  actionTitle: "Check deployment",
  formType: "jira",
});

const listForm = createLookupForm({
  title: "Inspect a CDN build",
  description: "List the commits introduced by a specific CDN build.",
  label: "CDN build version",
  inputId: "buildVersion",
  placeholder: "e.g. 202603.0.0-rc.817",
  hint: "Enter the complete CDN build version.",
  actionTitle: "List commits",
  formType: "list",
});

const branchForm = createLookupForm({
  title: "Inspect a release branch",
  description:
    "List commits added since the immediately preceding wxcc-desktop release branch.",
  label: "Release branch name",
  inputId: "branchName",
  placeholder: "e.g. wxcc-desktop-release-26-07-1226",
  hint: "Enter the complete branch name. Up to 50 commits are shown.",
  actionTitle: "List branch commits",
  formType: "branch",
});

const commandForm = {
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.0",
  body: [
    {
      type: "Container",
      style: "emphasis",
      items: [
        {
          type: "TextBlock",
          text: "CDN Deployment Explorer",
          weight: "Bolder",
          size: "Large",
          color: "Accent",
        },
        {
          type: "TextBlock",
          text: "Track Jira releases and deployments, locate commits, and inspect CDN builds or release branches.",
          wrap: true,
          isSubtle: true,
          spacing: "Small",
        },
      ],
    },
    {
      type: "Container",
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "commit: Find which CDN builds contain the commit SHA provided",
          weight: "Bolder",
          color: "Accent",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "commitSha",
          placeholder: "e.g. cb519c7",
          spacing: "Small",
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "jira: Find which CDN builds contain the JIRA key (CX-12345)",
          weight: "Bolder",
          color: "Accent",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "jiraKey",
          placeholder: "e.g. CX-12345",
          spacing: "Small",
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "list: List commits on provided CDN version",
          weight: "Bolder",
          color: "Accent",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "buildVersion",
          placeholder: "e.g. 202603.0.0-rc.817",
          spacing: "Small",
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "branch: List commits added since the preceding release branch",
          weight: "Bolder",
          color: "Accent",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "branchName",
          placeholder: "e.g. wxcc-desktop-release-26-07-1226",
          spacing: "Small",
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "track: Find release branches containing a Jira",
          weight: "Bolder",
          color: "Accent",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "trackerJiraKey",
          placeholder: "e.g. CX-12345",
          spacing: "Small",
        },
        {
          type: "Input.ChoiceSet",
          id: "trackerResultMode",
          style: "expanded",
          isMultiSelect: false,
          value: "all",
          choices: [
            { title: "All release branches", value: "all" },
            { title: "Earliest release branch", value: "earliest" },
          ],
        },
      ],
    },
  ],
  actions: [
    {
      type: "Action.Submit",
      title: "Find commit",
      data: { formType: "commits" },
    },
    {
      type: "Action.Submit",
      title: "Check Jira",
      data: { formType: "jira" },
    },
    {
      type: "Action.Submit",
      title: "List build",
      data: { formType: "list" },
    },
    {
      type: "Action.Submit",
      title: "List branch",
      data: { formType: "branch" },
    },
    {
      type: "Action.Submit",
      title: "Track Jira release",
      data: { action: "runJiraTracker" },
    },
  ],
};

function createJiraTrackerCard() {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.0",
    body: [
      {
        type: "TextBlock",
        text: "Jira release tracker",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: "Enter a Jira key:",
        wrap: true,
      },
      {
        type: "Input.Text",
        id: "jiraKey",
        placeholder: "CX-12345",
      },
      {
        type: "TextBlock",
        text: "Which release branches should be returned?",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: "resultMode",
        style: "expanded",
        isMultiSelect: false,
        value: "all",
        choices: [
          {
            title: "All",
            value: "all",
          },
          {
            title: "Earliest",
            value: "earliest",
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Run tracker",
        data: {
          action: "runJiraTracker",
        },
      },
    ],
  };
}

async function handleAttachmentAction(bot, trigger) {
  const inputs = trigger?.attachmentAction?.inputs || {};

  if (inputs.action !== "runJiraTracker") {
    return;
  }

  const isExplorerSubmission = Object.prototype.hasOwnProperty.call(
    inputs,
    "trackerJiraKey"
  );
  const submittedJiraKey = isExplorerSubmission
    ? inputs.trackerJiraKey
    : inputs.jiraKey;
  const jiraKey =
    typeof submittedJiraKey === "string"
      ? submittedJiraKey.trim().toUpperCase()
      : submittedJiraKey;
  const submittedResultMode = isExplorerSubmission
    ? inputs.trackerResultMode
    : inputs.resultMode;
  const selectedModes =
    typeof submittedResultMode === "string"
      ? submittedResultMode.split(",").map((mode) => mode.trim())
      : [];
  const resultMode = selectedModes.includes("earliest") ? "earliest" : "all";

  if (
    !isValidJiraKey(jiraKey) ||
    !selectedModes.length ||
    selectedModes.some((mode) => mode !== "all" && mode !== "earliest")
  ) {
    try {
      await bot.say("Invalid Jira tracker options supplied by the card.");
    } catch (error) {
      console.error(`Failed to report invalid tracker input: ${error.message}`);
    }
    return;
  }

  try {
    await bot.say(`Checking release branch history for ${jiraKey}...`);
    const output = await runJiraTracker(jiraKey, resultMode);
    await bot.say("markdown", `**${jiraKey}**\n\n${output}`);
  } catch (error) {
    console.error(`Jira tracker failed: ${error.message}`);

    try {
      await bot.say(
        `Unable to check release branches for ${jiraKey}. Please try again later.`
      );
    } catch (replyError) {
      console.error(
        `Failed to report Jira tracker error: ${replyError.message}`
      );
    }
  }
}

framework.on("attachmentAction", (bot, trigger) => {
  handleAttachmentAction(bot, trigger).catch((error) => {
    console.error(`Unexpected attachment action failure: ${error.message}`);
  });
});

framework.hears(
  "track",
  (bot) => {
    bot
      .sendCard(
        createJiraTrackerCard(),
        "Enter a Jira key and choose whether to return all release branches or only the earliest branch."
      )
      .catch((error) => {
        console.error(`Failed to send Jira tracker card: ${error.message}`);
      });
  },
  "**track**: (open the Jira release tracker)",
  0
);

framework.hears(
  /(^| )commits?( |$)/i,
  (bot) => {
    return bot.sendCard(commitsForm, "Please enter a Git commit SHA.");
  },
  "**commit**: find the CDN build containing a Git commit",
  0
);

framework.hears(
  "jira",
  (bot) => {
    return bot.sendCard(jiraForm, "Please enter the JIRA key.");
  },
  "**jira**: submit a JIRA key",
  0
);

framework.hears(
  "list",
  (bot) => {
    return bot.sendCard(listForm, "Please enter a CDN build version.");
  },
  "**list**: list the commits introduced by a CDN build",
  0
);

framework.hears(
  "branch",
  (bot) => {
    return bot.sendCard(branchForm, "Please enter a release branch name.");
  },
  "**branch**: list the commits in a release branch",
  0
);

framework.hears(
  "help",
  (bot) => {
    return bot.sendCard(
      commandForm,
      "CDN Deployment Explorer: use commit, jira, list, branch, or track."
    );
  },
  "**help**: list the available commands",
  0
);

framework.hears(
  /.*/,
  (bot) => {
    return bot.sendCard(
      commandForm,
      "Available commands: commit, jira, list, branch, track"
    );
  },
  99999
);

framework.on("attachmentAction", (bot, trigger) => {
  const submission = parseSubmission(trigger);

  if (!submission) {
    return;
  }

  if (!submission.isValid) {
    return bot.reply(trigger.attachmentAction, submission.error);
  }

  const handlers = {
    jira: [lookupCxDeployment, formatDeploymentReport, "CDN builds"],
    commits: [lookupCommitBuilds, formatCommitBuildsReport, "CDN builds"],
    list: [lookupBuildCommits, formatBuildCommitsReport, "build commits"],
    branch: [lookupBranchCommits, formatBranchCommitsReport, "branch commits"],
  };
  const [lookup, format, description] = handlers[submission.type];

  console.log(`${submission.type} lookup received: ${submission.value}`);
  return bot
    .reply(
      trigger.attachmentAction,
      `Looking up ${description} for **${submission.value}**...`
    )
    .then(() => lookup(submission.value))
    .then((report) =>
      bot.reply(trigger.attachmentAction, format(report), "markdown")
    )
    .catch((error) => {
      console.error(
        `${submission.type} lookup failed for ${submission.value}: ${
          error.stack || error.message
        }`
      );
      const message = formatLookupError(error, submission.value);
      return bot.reply(trigger.attachmentAction, message, "markdown");
    });
});

//Server config & housekeeping
// Health Check
app.get("/", (req, res) => {
  res.send(`I'm alive.`);
});

app.post("/", webhook(framework));

var server = app.listen(config.port, () => {
  framework.debug("framework listening on port %s", config.port);
});

// gracefully shutdown (ctrl-c)
process.on("SIGINT", () => {
  framework.debug("stopping...");
  server.close();
  framework.stop().then(() => {
    process.exit();
  });
});
