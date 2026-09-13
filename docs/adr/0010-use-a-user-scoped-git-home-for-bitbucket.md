# Use a user-scoped Git HOME for Bitbucket

Each Bitbucket Cloud Connection runs Git with HOME directed to its tenant- and user-scoped integration directory. The existing global Git configuration and credential-store setup therefore write `.gitconfig` and `.git-credentials` within that user scope, while allowing normal Git commands and both SSH-style and HTTPS Bitbucket URLs through the HTTPS URL rewrite.
