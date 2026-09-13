interface OperationRunPaginationProps {
  hasItems: boolean;
  hasNextPage: boolean;
  loadFailed: boolean;
  loading: boolean;
  onLoadMore: () => void;
  t: (key: string) => string;
}

export default function OperationRunPagination({
  hasItems,
  hasNextPage,
  loadFailed,
  loading,
  onLoadMore,
  t,
}: OperationRunPaginationProps) {
  if (!hasItems || (!hasNextPage && !loadFailed)) return null;
  return (
    <div className="operation-runs-pagination">
      {loadFailed ? <span role="alert">{t("operations.loadMoreFailed")}</span> : null}
      <button type="button" className="btn-secondary" disabled={loading} onClick={onLoadMore}>
        {loading ? t("operations.loadingMore") : t("operations.loadMore")}
      </button>
    </div>
  );
}
