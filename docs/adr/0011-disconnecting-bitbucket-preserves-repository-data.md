# Disconnecting Bitbucket preserves repository references and checkouts

Removing a user's active Bitbucket Cloud Connection deletes only its credentials and user-scoped Git HOME. Existing Repository References and their materialized Repository Checkouts remain available locally; creating, refreshing, or accessing the remote requires a newly configured connection, while deleting the Repository Reference still removes its bound checkout.
