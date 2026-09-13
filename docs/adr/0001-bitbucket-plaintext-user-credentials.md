# Store Bitbucket Cloud credentials as plaintext user-scoped files

Bitbucket Cloud API tokens will be stored as plaintext files in the authenticated user's tenant- and user-scoped server directory. The deployment environment has restricted server access, and the product explicitly accepts this trade-off in exchange for local Git and API access without an external secret manager; credentials must never be placed in process-global Git configuration or shared across user scopes.
