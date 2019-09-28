const Moment = require('moment');

// iterate over all environment variables and returns false when it encounters
// the first undefined variable. Returns true otherwise.
module.exports.verifyEnvVariablesExist = () => {
	const envVars = ["STAGE",
					 "CLIENT_ID",
					 "CLIENT_SECRET",
					 "SLACK_BOT_ID",
					 "LUIS_URL",
					 "ACCESS_TOKEN_TABLE_NAME",
					 "CHANNEL_CONTEXT_TABLE_NAME",
					 "JIRA_NAME",
					 "JIRA_PASSWORD",
					 "JIRA_URL",
					 "JIRA_ISSUE_ENDPOINT",
					 "JIRA_SEARCH_ENDPOINT",
					 "JIRA_PROJECT_ENDPOINT",
					 "JIRA_BOARD_ENDPOINT",
					 "JIRA_RAPIDVIEW_CONFIG_ENDPOINT",
					 "JIRA_REPORT_INFO_ENDPOINT"];
    return envVars.filter((variable) => process.env[variable] == null)
}

// return how long ago the argument 'date' is from now in
// 'friendly time' (e.g. a few seconds ago, 2 days ago)
module.exports.timeFromNow = (date) => {
    return Moment(date).fromNow();
};

module.exports.todaysDate = () => {
    return Moment().format('YYYY/MM/DD');
};

// HTTP template with embedded Slack install link for this bot
module.exports.installHTML = (clientId) =>
	`<!DOCTYPE html>
	<html>
		<head>
			<title>poet-bot</title>
		</head>
		<body>
			<h1>poet-bot</h1>
			<p>Click the button to add @poet to Slack!</p>
			<a href="https://slack.com/oauth/authorize?client_id=${clientId}&scope=channels:history,bot,users.profile:read,users:read">
			    <img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" />
			</a>
		</body>
	</html>`;

// HTTP template for routing to after successful installation
module.exports.authorizedHTML = () =>
	`<!DOCTYPE html>
	<html>
		<head>
			<title>poet-bot</title>
		</head>
		<body>
			<h1>poet-bot</h1>
			<p>Thanks and enjoy!</p>
		</body>
	</html>`;
