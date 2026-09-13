# Model Bitbucket references per repository

A Resource Library Bitbucket entry represents one repository, not a repository-and-branch pair. The user chooses a default branch during import for the first Repository Checkout; later branch changes use normal Git operations, and simultaneous checkouts of multiple branches are deferred until Git worktrees are needed.
