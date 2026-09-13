import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/ResourcePicker.tsx", import.meta.url),
  "utf8",
);
const resourceLibraryPageSource = readFileSync(
  new URL("../src/components/ResourceLibraryPage.tsx", import.meta.url),
  "utf8",
);
const resourceLibraryApiSource = readFileSync(
  new URL("../src/services/api/resource-library.ts", import.meta.url),
  "utf8",
);

test("conversation Bitbucket picker exposes repository loading during initial load and search", () => {
  assert.match(
    source,
    /const \[bitbucketRepositoriesLoading, setBitbucketRepositoriesLoading\] = useState\(false\)/,
    "repository requests need loading state independent from connection/import work",
  );
  assert.match(
    source,
    /setBitbucketRepositoriesLoading\(true\)[\s\S]*listBitbucketRepositories\(bitbucketRepositorySearch\)[\s\S]*setBitbucketRepositoriesLoading\(false\)/,
    "initial repository load and debounced search must bracket the request with loading state",
  );
  assert.match(
    source,
    /bitbucketRepositoriesLoading\s*\?\s*t\("resource\.bitbucketRepositorySearching"\)\s*:\s*t\("resource\.bitbucketRepositorySelect"\)/,
    "the repository trigger must announce loading before a repository is selected",
  );
  assert.match(
    source,
    /className="rl-bitbucket-repository-options"[\s\S]*bitbucketRepositoriesLoading\s*\?\s*<p[^>]*role="status"[^>]*>\{t\("resource\.bitbucketRepositorySearching"\)\}<\/p>/,
    "the open repository list must expose an accessible loading status",
  );
});

test("expired Bitbucket credentials route users to connection updates without site logout", () => {
  assert.match(
    resourceLibraryApiSource,
    /isBitbucketConnectionInvalidError[\s\S]*409/,
    "the resource API must identify the non-auth status used for an invalid Bitbucket connection",
  );
  assert.match(
    resourceLibraryPageSource,
    /isBitbucketConnectionInvalidError\(error\)[\s\S]*setBitbucketConnectionSettings\(true\)/,
    "the Resource Library must open connection settings when Bitbucket credentials expire",
  );
  assert.match(
    source,
    /isBitbucketConnectionInvalidError\(error\)[\s\S]*setBitbucketConnection[\s\S]{0,160}connected:\s*false/,
    "the conversation picker must return to connection setup when Bitbucket credentials expire",
  );
});
