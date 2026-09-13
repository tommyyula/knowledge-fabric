# Configure Bitbucket Cloud credentials

This guide explains how to create an Atlassian API token and connect it to the Knowledge Fabric Resource Library. Once connected, you can list the Bitbucket repositories and branches available to your account, and the selected token is used for Git operations during import.

## Before you start

- Use an Atlassian account that can access the repositories you intend to import.
- An API token is shown in full only once, immediately after it is created. Copy and store it securely.
- Never share a token in chat, email, tickets, or a Git repository. Revoke it in Atlassian and create a replacement if you suspect exposure.

## 1. Open the API token page

Open the [Atlassian API token management page](https://id.atlassian.com/manage-profile/security/api-tokens). On the **Security** page, choose **Create scoped API token**.

![Create a scoped API token from the Atlassian Security page](step0.png)

## 2. Enter a name and expiry date

Choose a recognisable name, such as `knowledge-fabric-bitbucket`, and set an expiry date that follows your team's security policy. When the token expires, create a new token and update the connection in Knowledge Fabric.

![Enter the API token name and expiry date](step1.png)

## 3. Select Bitbucket

Under **Select the app**, select **Bitbucket**, then click **Next**.

![Select the Bitbucket app](step2.png)

## 4. Select scopes

Choose the Bitbucket scopes required for your use case:

- Importing and browsing repositories and branches requires repository read access and permission to read the current account information.
- If future Git or Bitbucket API operations need to write to a repository, create branches, or open pull requests, also select the corresponding write scopes.

The screenshot shows how to filter scope actions by **Read** and **Write**. Knowledge Fabric does not apply a separate Git-operation restriction: Bitbucket determines the remote read and write operations allowed by the token.

![Select Bitbucket scopes](step3.png)

## 5. Review and create the token

Review the name, expiry date, app, and scopes, then click **Create token**. Copy the token immediately when it is displayed.

![Review and create the API token](step4.png)

## 6. Connect it to Knowledge Fabric

1. Open **Resource Library**, then **Connect Services**.
2. Select **Connect Bitbucket Cloud**.
3. Enter the email address for the Atlassian account and the API token you copied.
4. Click **Verify and save**. The message `Connected: your email` confirms success.
5. Click **Import from Bitbucket**, select a repository and its default branch, then import it.

The selected default branch is fetched during import. Large repositories may take some time; the Resource Library list refreshes automatically after a successful import.

## Troubleshooting

### Repositories or branches are not listed

Check that the token is still valid, was created for the Bitbucket app, and includes the required read scopes. Also confirm that the Atlassian account itself can access the target workspace and repository.

### Git authentication fails or repository access is denied

First, verify that you can open the repository in a browser while signed in to the same account. If you can, save the token again and retry. If the error remains, check the token's repository-read scope and expiry date.

### The token is exposed or no longer needed

Revoke it from the Atlassian API token management page, create a new token, and use **Verify and save** again in Knowledge Fabric.
