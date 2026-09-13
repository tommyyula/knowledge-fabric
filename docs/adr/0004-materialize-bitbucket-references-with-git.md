# Materialize Bitbucket references with Git in ontology workspaces

Bitbucket repository entries will not be expanded into ordinary Resource Library file resources. When a knowledge base references one, the server will use that user's configured Git credentials to initialize and check out the repository under the ontology workspace's `raw/repos/` directory, then record a resource binding to that directory. Existing binding deletion will remove this checkout when the Resource Library entry is deleted.
