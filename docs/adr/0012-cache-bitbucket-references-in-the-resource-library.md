# Cache Bitbucket Repository References in the Resource Library

Each Bitbucket Repository Reference has a user-scoped Repository Cache in the Resource Library, checked out at import on the selected default branch. The cache provides repository size, file browsing, and text preview without coupling those operations to an ontology. Ontology references continue to create their own Repository Checkout under `raw/repos/`, so an ontology's Git state remains independent of the Resource Library cache.

This supersedes the Resource Library portion of ADR-0004: Repository References still are not expanded into ordinary individual Resource Library file entries, but their Repository Cache is now materialized for user-facing inspection.
