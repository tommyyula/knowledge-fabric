export interface ComposioAppMetadata {
  app: string;
  name: string;
  icon: string;
  logo: string;
  description: string;
  connectorType: "email" | "storage" | "messaging" | "saas";
  capabilities: string[];
  toolkit: string;
}

export const SUPPORTED_COMPOSIO_APPS: ComposioAppMetadata[] = [
  { app: "github", name: "GitHub", icon: "github", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/github.svg", description: "Repositories, issues, PRs", connectorType: "saas", capabilities: ["repository_read", "issue_read", "issue_write", "pull_request_read", "pull_request_write"], toolkit: "github" },
  { app: "bitbucket", name: "Bitbucket", icon: "git-branch", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/bitbucket.svg", description: "Repositories and pull requests", connectorType: "saas", capabilities: [], toolkit: "bitbucket" },
  { app: "gmail", name: "Gmail", icon: "mail", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/gmail.svg", description: "Send and read emails", connectorType: "email", capabilities: ["send_email", "read_email", "search_email"], toolkit: "gmail" },
  { app: "outlook", name: "Outlook", icon: "mail", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/microsoftoutlook.svg", description: "Email, calendar, contacts", connectorType: "email", capabilities: ["send_email", "read_email", "search_email", "calendar_read", "calendar_write"], toolkit: "outlook" },
  { app: "slack", name: "Slack", icon: "message-square", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/slack.svg", description: "Messages and channels", connectorType: "messaging", capabilities: ["send_message", "read_message", "channel_read"], toolkit: "slack" },
  { app: "jira", name: "Jira", icon: "ticket", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/jira.svg", description: "Issues and projects", connectorType: "saas", capabilities: ["issue_read", "issue_write", "project_read"], toolkit: "jira" },
  { app: "notion", name: "Notion", icon: "file-text", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/notion.svg", description: "Pages and databases", connectorType: "saas", capabilities: ["page_read", "page_write", "database_read", "database_write"], toolkit: "notion" },
  { app: "google-calendar", name: "Google Calendar", icon: "calendar", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googlecalendar.svg", description: "Events and scheduling", connectorType: "saas", capabilities: ["calendar_read", "calendar_write", "event_read", "event_write"], toolkit: "googlecalendar" },
  { app: "google-drive", name: "Google Drive", icon: "hard-drive", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googledrive.svg", description: "Files and folders", connectorType: "storage", capabilities: ["file_read", "file_write", "folder_read"], toolkit: "googledrive" },
  { app: "google-sheets", name: "Google Sheets", icon: "table", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googlesheets.svg", description: "Spreadsheets and data", connectorType: "saas", capabilities: ["spreadsheet_read", "spreadsheet_write", "sheet_read"], toolkit: "googlesheets" },
  { app: "google-docs", name: "Google Docs", icon: "file-text", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googledocs.svg", description: "Documents and text", connectorType: "saas", capabilities: ["document_read", "document_write"], toolkit: "googledocs" },
  { app: "linear", name: "Linear", icon: "layers", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/linear.svg", description: "Issues and projects", connectorType: "saas", capabilities: ["issue_read", "issue_write", "project_read"], toolkit: "linear" },
  { app: "confluence", name: "Confluence", icon: "book-open", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/confluence.svg", description: "Documentation and spaces", connectorType: "saas", capabilities: ["page_read", "page_write", "space_read"], toolkit: "confluence" },
  { app: "trello", name: "Trello", icon: "layout", logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/trello.svg", description: "Boards and cards", connectorType: "saas", capabilities: ["card_read", "card_write", "board_read"], toolkit: "trello" },
];

const metadataByApp = new Map(SUPPORTED_COMPOSIO_APPS.map((item) => [item.app, item]));

export function normalizeComposioApp(app: string): string {
  return app.trim().toLowerCase();
}

export function getComposioAppMetadata(app: string): ComposioAppMetadata | undefined {
  return metadataByApp.get(normalizeComposioApp(app));
}

export function getComposioToolkitSlug(app: string): string {
  return getComposioAppMetadata(app)?.toolkit ?? normalizeComposioApp(app).replace(/-/g, "");
}
