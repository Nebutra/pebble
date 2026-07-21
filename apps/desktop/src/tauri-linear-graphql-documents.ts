const USER = 'id displayName avatarUrl'
const ISSUE = `id identifier title description url dueDate estimate priority updatedAt state { name type color }
  team { id name key } project { id name url color } assignee { ${USER} } labels(first: 50) { nodes { id name } }`
const PROJECT = `id name description content url color icon health priority priorityLabel progress scope startDate targetDate
  createdAt updatedAt completedAt canceledAt startedAt status { id name type color } lead { ${USER} }
  members(first: 50) { nodes { ${USER} } } teams(first: 50) { nodes { id name key } }
  labels(first: 50) { nodes { id name color } } projectMilestones(first: 20) { nodes { id name status targetDate progress } }
  externalLinks(first: 20) { nodes { id label url } }`
const VIEW = `id name description modelName color icon shared slugId createdAt updatedAt team { id name key }
  owner { ${USER} } creator { ${USER} }`

export const linearDocuments = {
  searchIssues: `query Search($term:String!,$first:Int!){ searchIssues(term:$term,first:$first){nodes{${ISSUE}}} }`,
  issues: `query Issues($first:Int!,$filter:IssueFilter){ issues(first:$first,filter:$filter,orderBy:updatedAt){nodes{${ISSUE}}} }`,
  viewerAssigned: `query Issues($first:Int!,$filter:IssueFilter){viewer{assignedIssues(first:$first,filter:$filter,orderBy:updatedAt){nodes{${ISSUE}}}}}`,
  viewerCreated: `query Issues($first:Int!,$filter:IssueFilter){viewer{createdIssues(first:$first,filter:$filter,orderBy:updatedAt){nodes{${ISSUE}}}}}`,
  issue: `query Issue($id:String!){issue(id:$id){${ISSUE}}}`,
  issueCreate: `mutation Create($input:IssueCreateInput!){issueCreate(input:$input){success issue{ id identifier title url }}}`,
  issueUpdate: `mutation Update($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}`,
  commentCreate: `mutation Comment($input:CommentCreateInput!){commentCreate(input:$input){success comment{id}}}`,
  comments: `query Comments($id:String!){issue(id:$id){comments(first:100){nodes{id body createdAt updatedAt user{${USER}}}}}}`,
  teams: `query Teams{teams(first:100){nodes{id name key}}}`,
  teamStates: `query States($id:String!){team(id:$id){states(first:100){nodes{id name type color position}}}}`,
  teamLabels: `query Labels($id:String!){team(id:$id){labels(first:100){nodes{id name color}}}}`,
  teamMembers: `query Members($id:String!){team(id:$id){members(first:100){nodes{${USER}}}}}`,
  projects: `query Projects($first:Int!){projects(first:$first){nodes{${PROJECT}}}}`,
  searchProjects: `query Projects($term:String!,$first:Int!){searchProjects(term:$term,first:$first){nodes{${PROJECT}}}}`,
  project: `query Project($id:String!){project(id:$id){${PROJECT}}}`,
  projectCreate: `mutation Create($input:ProjectCreateInput!){projectCreate(input:$input){success project{${PROJECT}}}}`,
  projectIssues: `query ProjectIssues($id:String!,$first:Int!){project(id:$id){issues(first:$first){nodes{${ISSUE}}}}}`,
  customViews: `query Views($first:Int!){customViews(first:$first){nodes{${VIEW}}}}`,
  customView: `query View($id:String!){customView(id:$id){${VIEW}}}`,
  customViewIssues: `query View($id:String!,$first:Int!){customView(id:$id){issues(first:$first){nodes{${ISSUE}}}}}`,
  customViewProjects: `query View($id:String!,$first:Int!){customView(id:$id){projects(first:$first){nodes{${PROJECT}}}}}`
} as const
