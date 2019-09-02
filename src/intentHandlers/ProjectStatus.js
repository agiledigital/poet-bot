const ContextService = require('../services/ContextService.js');
const SlackService = require('../services/SlackService.js');
const JiraService = require('../services/JiraService.js');
const DBService = require('../services/DBService.js');
const Utils = require('../services/Utils.js');
const async = require('asyncawait/async');
const await = require('asyncawait/await');
const fp = require('lodash/fp');

module.exports.process = async ((event, token, entities) => {
    // check if the user specified which check to do specifically
    var checksToGet = 'all';
    if (entities.length != 0){
        checksToGet = entities[0].entity;
    }

    // get the context information for this channel
    const ContextResponse = await (DBService.retrieveChannelContext(event.channel)
        .catch(error => {throw new Error(`Failed to fetch project key for channel context: ${error}`)}));

    if (!ContextResponse || !ContextResponse.projectKey){
        throw new Error("Please set a channel project first using e.g. '@poet Set the project to POET'");
    }

    // get the project Kanban board ID from DB, updating it if its not there
    const projectKey = ContextResponse.projectKey;
    var kanbanBoardID = ContextResponse.kanbanBoardID || null;
    if (!kanbanBoardID){
        //Update all Project kanban information
        kanbanBoardID = await (ContextService.updateProjectKanbanBoardInfo(projectKey, event.channel));
        if (kanbanBoardID === 'notFound'){
            throw new Error(`Couldn't find a *Kanban board* for the project *${projectKey}*`);
        }
    }

    // get the project info
    const jiraResponse = await (JiraService.projectInfo(projectKey)
        .catch(error => {throw new Error(`Error in *Project Status* while fetching project information for *${projectKey}*":\n${error.message}`)}));
    const name = jiraResponse['name'];

    // get the Kanban configuration information for the project
    const boardConfig = await (JiraService.boardInfo(`${kanbanBoardID}/configuration`)
        .catch(error => {throw new Error(`error getting board/${kanbanBoardID}/configuration: ${error}`)}));
    const columns = boardConfig.columnConfig.columns;
    var boardSubQuery;
    if (boardConfig.subQuery.query){
        boardSubQuery = 'and ' + boardConfig.subQuery.query;
    }

    // extract which status IDs belong to the backlog and which do not
    const backlogStatusIDs = [];
    const notBacklogStatusIDs = [];
    for (i = 0; i < columns.length; i++){
        if (columns[i].name.toUpperCase() === 'BACKLOG'){
            for (j = 0; j < columns[i].statuses.length; j++){
                backlogStatusIDs.push(columns[i].statuses[j].id);
            }
        }else{
            for (j = 0; j < columns[i].statuses.length; j++){
                notBacklogStatusIDs.push(columns[i].statuses[j].id);
            }
        }
    }

    // update the context database timestamps only once a day
    if (ContextResponse.newestTS){
        if (ContextResponse.newestTS != Utils.todaysDate()){
            if (ContextResponse.middleTS){
                const tempTS1 = ContextResponse.newestTS;
                const tempTS2 = ContextResponse.middleTS;
                await (DBService.updateChannelContext(event.channel, { newestTS: Utils.todaysDate() , middleTS: tempTS1 , oldestTS: tempTS2 })
                   .catch(error => console.log(`Failed to update project status timestamps: ${error}`)));
            }else{
                const tempTS = ContextResponse.newestTS;
                await (DBService.updateChannelContext(event.channel, { newestTS: Utils.todaysDate() , middleTS: tempTS })
                   .catch(error => console.log(`Failed to update project status timestamps: ${error}`)));
            }
        }
    }else{
        await (DBService.updateChannelContext(event.channel, { newestTS: Utils.todaysDate() })
           .catch(error => console.log(`Failed to update project status timestamps: ${error}`)));
    }

    // Send the results of the checks requested by the user to Slack
    const text = `Here is the current status of the project *${JiraService.HyperlinkJiraProjectKey(projectKey, name)}*`;
    await (SlackService.postMessage(event.channel, text, [{}], token));
    switch (checksToGet){
        case 'kanban':
            var kanbanCheckResults = await (kanbanChecks(projectKey, kanbanBoardID, notBacklogStatusIDs, ContextResponse.middleTS, ContextResponse.oldestTS, boardSubQuery, boardConfig));
            await (SlackService.postMessage(event.channel, 'Kanban Checks:', kanbanCheckResults, token));
            break;
        case 'backlog':
            var backlogCheckResults = await (backlogChecks(projectKey, kanbanBoardID, backlogStatusIDs, ContextResponse.middleTS, ContextResponse.oldestTS));
            await (SlackService.postMessage(event.channel, 'Backlog Checks:', backlogCheckResults, token));
            break;
        case 'report':
            var reportCheckResults = await (reportChecks(projectKey, kanbanBoardID));
            await (SlackService.postMessage(event.channel, 'Report Checks:', reportCheckResults, token));
            break;
        case 'unreleased':
            var ticketsAwaitingReleaseResults = await (findTicketsAwaitingRelease(projectKey, kanbanBoardID));
            await (SlackService.postMessage(event.channel, 'Tickets Awaiting Release:', ticketsAwaitingReleaseResults, token));
            break;
        case 'all':
            // do all checks
            kanbanCheckResults = await (kanbanChecks(projectKey, kanbanBoardID, notBacklogStatusIDs, ContextResponse.middleTS, ContextResponse.oldestTS, boardSubQuery, boardConfig));
            backlogCheckResults = await (backlogChecks(projectKey, kanbanBoardID, backlogStatusIDs, ContextResponse.middleTS, ContextResponse.oldestTS));
            reportCheckResults = await (reportChecks(projectKey, kanbanBoardID));
            ticketsAwaitingReleaseResults = await (findTicketsAwaitingRelease(projectKey, kanbanBoardID));
            // Send the results to Slack in order
            await (SlackService.postMessage(event.channel, ':one: Kanban Checks:', kanbanCheckResults, token));
            await (SlackService.postMessage(event.channel, ':two: Backlog Checks:', backlogCheckResults, token));
            await (SlackService.postMessage(event.channel, ':three: Report Checks:', reportCheckResults, token));
            await (SlackService.postMessage(event.channel, ':four: Tickets Awaiting Release:', ticketsAwaitingReleaseResults, token));
            break;
        default:
            throw new Error(`${checksToGet} is not a check type. Please specify either 'kanban', 'backlog' or 'report'.`);
    }
});

// Check the project kanban board and return an array of objects consisting of the results
const kanbanChecks = async ((projectKey, kanbanBoardID, StatusIDs, middleTS, oldestTS, boardSubQuery, boardConfig) => {
    var kanbanChecks = [];
    // list newly created tickets in the last week
    kanbanChecks = kanbanChecks.concat(await (newlyCreated(kanbanBoardID, StatusIDs, middleTS, oldestTS, boardSubQuery)));

    // list tickets not updated in last week. TODO highlight if in Stalled, In Progress or Completed
    kanbanChecks = kanbanChecks.concat(await (notUpdated(kanbanBoardID, StatusIDs, boardSubQuery)));

    //list tickets on issues when there are multipla with story points > 3
    kanbanChecks = kanbanChecks.concat(await (largeIssues(kanbanBoardID, boardConfig)))

    //list tickets on issues that have an overflowing kanban column
    kanbanChecks = kanbanChecks.concat(await (redColumnCheck(kanbanBoardID, boardConfig)));

    if (kanbanChecks.length == 0){
        kanbanChecks.push({"text": 'Kanban is all good! :white_check_mark:' , "color": "good"});
    }
    return kanbanChecks;
});

// Check the project backlog and return an array of objects consisting of the results
const backlogChecks = async ((projectKey, kanbanBoardID, StatusIDs, middleTS, oldestTS) => {
    var backlogChecks = [];
    // list newly created tickets in the last week or since the last checked date
    backlogChecks = backlogChecks.concat(await (newlyCreated(kanbanBoardID, StatusIDs, middleTS, oldestTS)));

    // list tickets not updated in last week
    backlogChecks = backlogChecks.concat(await (notUpdated(kanbanBoardID, StatusIDs)));

    // give a link to the project backlog so they can confirm the priority of issues
    const link = `${process.env.JIRA_URL}/secure/RapidBoard.jspa?projectKey=${projectKey}&rapidView=${kanbanBoardID}&view=planning`;
    backlogChecks.push({"text": `:exclamation:Check the <${link}|project backlog> to ensure the issues are prioritised correctly.`, "color": "danger"});

    if (backlogChecks.length == 0){
        backlogChecks.push({"text": "Backlog is all good! :white_check_mark:" , "color": "good"});
    }
    return backlogChecks;
});

// Check the project reports and return an array of objects consisting of the results
const reportChecks = async ((projectKey, kanbanBoardID) => {
    var reportChecks = [];
    const reportInfo = await (JiraService.reportsInfo(kanbanBoardID)
        .catch(error => {throw new Error(`Error getting reportInfo for kanbanBoardID ${kanbanBoardID}: ${error}`)}));

    // extract column id's for the desired columns in report. Use them to build report links
    var controlChartColumns = [];
    var cumulativeFlowColumns = [];
    for (i = 0; i < reportInfo.columns.length; i++){
        const name = reportInfo.columns[i].name;
        if (name === 'Stalled' || name === 'In Progress' || name === 'Completed'){
            controlChartColumns.push(reportInfo.columns[i].id);
        }
        if (name !== 'Backlog'){
            cumulativeFlowColumns.push(reportInfo.columns[i].id);
        }
    }

    // construct the Control Chart and Cumulative Flow Diagram links
    const controlChartLink = `${process.env.JIRA_URL}/secure/RapidBoard.jspa?rapidView=${kanbanBoardID}&projectKey=${projectKey}&view=reporting&chart=controlChart&days=14&column=${controlChartColumns.join('&column=')}`;
    const CumulativeDiagramLink = `${process.env.JIRA_URL}/secure/RapidBoard.jspa?rapidView=${kanbanBoardID}&projectKey=${projectKey}&view=reporting&chart=cumulativeFlowDiagram&days=14&column=${cumulativeFlowColumns.join('&column=')}`;
    reportChecks.push({"text": `:exclamation:Check the <${controlChartLink}|Control Chart> and <${CumulativeDiagramLink}|Cumulative Flow Diagram>.`, "color": "danger"});

    // TODO statistically analyse raw report data and report on the averages and any outliers

    if (reportChecks.length == 0){
        reportChecks.push({"text": 'Reports are all good! :white_check_mark:' , "color": "good"});
    }
    return reportChecks;
});

const findTicketsAwaitingRelease = async ((projectKey, kanbanBoardID) => {
    let ticketsAwaitingRelease = await (JiraService.boardInfo(`${kanbanBoardID}/issue?jql=issueType!= Epic and resolution in (Done, Fixed) ORDER BY updated ASC`)
        .catch(error => {throw new Error(`Error finding tickets awaiting release on kanban board ${kanbanBoardID}: ${error}`)}));

    const total = ticketsAwaitingRelease.total;
    return [{
        "text": `:exclamation: There are ${total > 0 ? total : 'no'} tickets awaiting release. ${returnIssues(ticketsAwaitingRelease)}`,
        "color": "danger",
        "mrkdwn_in": ["text"],
    }];
});

// given board and status IDs and a potential subquery, query JIRA and return a list of issues not updated in the last week
const notUpdated = async ((kanbanBoardID, StatusIDs, subQuery = '') => {
    var notUpdated = [];
    notUpdatedRecentlyIssues = await (JiraService.boardInfo(`${kanbanBoardID}/issue?jql=status in (${StatusIDs.join(',')}) and issueType!= Epic and updatedDate <= -1w ${subQuery} and resolution is EMPTY ORDER BY updated ASC`)
       .catch(error => {throw new Error(`error getting backlogIssues 1: ${error}`)}));
    const total = notUpdatedRecentlyIssues.total;
    if (total > 0){
        notUpdated.push({
                                "text": `:exclamation: There are ${total} issues not updated in more than a week. ${returnIssues(notUpdatedRecentlyIssues)}`,
                                "color": "danger",
                                "mrkdwn_in": ["text"]
                            });
    }
    return notUpdated;
});

// given a board ID, status IDs, timestamps and a potential subquery, query JIRA and return an array of issues created recently
const newlyCreated = async ((kanbanBoardID, StatusIDs, middleTS, oldestTS, subQuery = '') => {
    var newlyCreated = [];
    var createdRecentlyIssues;
    var createdPreviouslyIssues;
    var lastCheck;
    if (!middleTS){
        // show issues created in the last week
        createdRecentlyIssues = await (JiraService.boardInfo(`${kanbanBoardID}/issue?jql=status in (${StatusIDs.join(',')}) and issueType!= Epic and createdDate >= -1w ${subQuery} and resolution is EMPTY ORDER BY created DESC`)
            .catch(error => {throw new Error(`error getting backlogIssues 1: ${error}`)}));
        lastCheck = "a week ago";
    }else{
        // query JIRA for issues created since the last check (i.e. since middleTS)
        createdRecentlyIssues = await (JiraService.boardInfo(`${kanbanBoardID}/issue?jql=status in (${StatusIDs.join(',')}) and issueType!= Epic and createdDate>="${middleTS}" ${subQuery} and resolution is EMPTY ORDER BY created DESC`)
            .catch(error => {throw new Error(`error getting backlogIssues 2: ${error}`)}));
        if (oldestTS){
            // remind the user about which newly created tickets were shown last time
            createdPreviouslyIssues = await (JiraService.boardInfo(`${kanbanBoardID}/issue?jql=status in (${StatusIDs.join(',')}) and issueType!= Epic and createdDate>="${oldestTS}" and createdDate<"${middleTS}" ${subQuery} and resolution is EMPTY ORDER BY created DESC`)
                .catch(error => {throw new Error(`error getting backlogIssues 3: ${error}`)}));
        }
        lastCheck = Utils.timeFromNow(middleTS);
    }

    const total1 = createdRecentlyIssues.total;
    var total2 = -1;
    if (createdPreviouslyIssues){
        total2 = createdPreviouslyIssues.total;
    }

    // construct the responses
    if (total1 > 0){
        newlyCreated.push({
                                "text": `:exclamation: There are ${total1} new issues since your last check ${lastCheck}:${returnIssues(createdRecentlyIssues)}`,
                                "color": "danger",
                                "mrkdwn_in": ["text"]
                            });
    }else{
        newlyCreated.push({
                                "text": `No new issues since your last check ${lastCheck} :white_check_mark:`,
                                "color":"good",
                                "mrkdwn_in": ["text"]
                            });
    }
    if (total2 > 0){
        newlyCreated.push({
                                "text": `:exclamation: As a reminder, here is a list of the newly created issues I showed you ${Utils.timeFromNow(oldestTS)}:${returnIssues(createdPreviouslyIssues)}`,
                                "color": "danger",
                                "mrkdwn_in": ["text"]
                            });
    }

    return newlyCreated;
});

// Checks if there are any red columns and returns array of objects consisting of the results
const redColumnCheck = async((kanbanBoardID, boardConfig) => {
    const allOk = [goodSlackResponse(`Kanban board Columns are all healthy! :white_check_mark:`)];
    const columns = boardConfig.columnConfig.columns;
    const getStatusIDs = function (column) {
        var statusIDs;
        if (column.name.toUpperCase() !== 'BACKLOG') {
            statusIDs = fp.map('id')(column.statuses);
        } else {
            return null;
        }
        return [column, statusIDs];
    };
    const checkColumn = (columnstatusIDs) => {
        if (columnstatusIDs != null){
            column = columnstatusIDs[0];
            statusIDs = columnstatusIDs[1];
            const jql =`jql=status in (${statusIDs.join(',')}) and issueType!= Epic and resolution is EMPTY ORDER BY created DESC`;
            const jiraResponse = await(jiraBoardInfo(kanbanBoardID, jql));
            if (jiraResponse.issues.length > column.max){
                return dangerSlackResponse(`:exclamation: The ${column.name} column is overflowing with the following issues:${issuesWithAssignee(jiraResponse)}`);
            }
        }
        return null;
    };
    const redColumns = (fp.flow((fp.map (getStatusIDs)), (fp.map (checkColumn)))(columns)).filter(Boolean);  
    return (redColumns.length === 0) ? allOk : redColumns;
})

// Checks the 'prioritised' or 'scoped' columns for large issues and return an array of objects consisting of the results
const largeIssues = async((kanbanBoardID, boardConfig) => {
    const columns = boardConfig.columnConfig.columns;
    const result = ((column) => {
        if (column.statuses.length > 0) {
            const issues = await(returnLargeIssues(kanbanBoardID, column.statuses));
            if(columnName(column) == "PRIORITISED"){
                if (issues !== '') {
                    return [dangerSlackResponse(`:exclamation: The prioritised column has the following tickets with story points > 3:${result}`)];
                }
            } else if (columnName(column) == "SCOPED"){
                if (issues !== '') {
                    return [dangerSlackResponse(`:exclamation: The scoped column has the following tickets with story points > 3:${result}`)];
                }
            }
        }
        return [];
    })
    const columnName = function (column){
        return column.name.toUpperCase();
    }
    const missingColumns = function (columnNames){
        if (!(columnNames.includes("PRIORITISED")) &&  !(columnNames.includes("SCOPED")))
            return [dangerSlackResponse(`:warning: The project is missing a prioritised column and a scoped column`)];
        if (!(columnNames.includes("PRIORITISED")))
            return [dangerSlackResponse(`:warning: The project is missing a prioritised column`)];
        if (!(columnNames.includes("SCOPED")))
            return [dangerSlackResponse(`:warning: The project is missing a a scoped column`)];       
        return [];
    }
    const missingColumn = fp.flow(fp.map(columnName), missingColumns)(columns);
    return missingColumn.concat(fp.flatMap(result)(columns));
});

// Returns issues that have storypoints > 3 if there is more than one of them
const returnLargeIssues = async((kanbanBoardID, statuses) => {
    const statusIDs = fp.map('id')(statuses);
    const jql =`jql=status in (${statusIDs.join(',')}) and issueType!= Epic and resolution is EMPTY ORDER BY created DESC`;
    const jiraResponse = await(jiraBoardInfo(kanbanBoardID, jql));
    const getLargeIssues = ((issue) => {
        if (parseInt(issue[`fields`][process.env.JIRA_STORYPOINTS]) > 3){
            return issue;
        }
        return null;
    });
    const getslackIssues = ((issue) => {
        const titles = `*${JiraService.HyperlinkJiraIssueID(issue['key'])}* - *${issue['fields']['summary']}*`;
        const timeAgos = Utils.timeFromNow(issue["fields"]['updated']);
        return `\n${titles} (${timeAgos})`;
    });
    const largeIssues = (fp.map(getLargeIssues)(jiraResponse.issues)).filter(Boolean);
    if (largeIssues.length > 1){
        return fp.map(getslackIssues)(largeIssues);
    }
    return '';
});

// return a list of new-line ended JIRA ticket information in the form 'JIRA_KEY - JIRA_SUMMARY (TIME_AGO)'
const returnIssues = (JiraResponse) => {
    var result = '';
    const numOfIssues = JiraResponse.total;
    if (numOfIssues > 0){
        for (i = 0; i < numOfIssues; i++){
            var titles = `*${JiraService.HyperlinkJiraIssueID(JiraResponse['issues'][i]['key'])}* - *${JiraResponse['issues'][i]['fields']['summary']}*`;
            var timeAgos = Utils.timeFromNow(JiraResponse['issues'][i]["fields"]['updated']);
            result += `\n${titles} (${timeAgos})`;
        }
    }
    return result;
};

// return a list of new-line ended JIRA ticket information in the form 'JIRA_KEY - JIRA_ASSIGNEE - JIRA_SUMMARY (TIME_AGO)'
const issuesWithAssignee = (JiraResponse) => {
    var result = '';
    const numOfIssues = JiraResponse.total;
    for (i = 0; i < numOfIssues; i++){
        const titles = `*${JiraService.HyperlinkJiraIssueID(JiraResponse['issues'][i]['key'])}* - *${JiraResponse['issues'][i]['fields']['summary']}*`;
        const assignee = `- *${JiraResponse['issues'][i][`fields`]['assignee']['displayName']}*`;
        const timeAgos = Utils.timeFromNow(JiraResponse['issues'][i]["fields"]['updated']);
        result += `\n${titles} ${assignee} (${timeAgos})`;
    }
    return result;
};

const jiraBoardInfo = async((kanbanBoardID, jql) => {
    const jiraResponse = await(JiraService.boardInfo(`${kanbanBoardID}/issue?${jql}`)
        .catch(error => { throw new Error(`error getting returnLargeIssues: ${error}`) }));  
    return jiraResponse;    
})

const goodSlackResponse = (message) => {
    return ({
        "text": `${message}`,
        "color":"good",
        "mrkdwn_in": ["text"]
    });
}

const dangerSlackResponse = (message) => {
    return({
        "text": `${message}`,
         "color": "danger",
         "mrkdwn_in": ["text"]
     });
}