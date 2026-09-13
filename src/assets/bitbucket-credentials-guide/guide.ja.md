# Bitbucket Cloud 認証情報の設定

このガイドでは、Atlassian API トークンを作成し、Knowledge Fabric のリソースライブラリへ接続する手順を説明します。接続後は、アカウントがアクセスできる Bitbucket リポジトリとブランチを一覧表示でき、インポート時の Git 操作にはこのトークンが使用されます。

## 開始前に

- インポート対象のリポジトリにアクセスできる Atlassian アカウントを使用してください。
- API トークンの完全な値は、作成直後に一度だけ表示されます。すぐにコピーし、安全に保管してください。
- トークンをチャット、メール、チケット、Git リポジトリで共有しないでください。漏えいの可能性がある場合は、Atlassian で失効させて新しいトークンを作成してください。

## 1. API トークン画面を開く

[Atlassian API token 管理画面](https://id.atlassian.com/manage-profile/security/api-tokens)を開きます。**Security** ページで **Create scoped API token** を選択します。

![Atlassian Security ページで scoped API token を作成する](step0.png)

## 2. 名前と有効期限を入力する

`knowledge-fabric-bitbucket` など、用途が分かる名前を付け、チームのセキュリティポリシーに合う有効期限を設定します。期限が切れたら、新しいトークンを作成して Knowledge Fabric の接続情報を更新してください。

![API token の名前と有効期限を入力する](step1.png)

## 3. Bitbucket を選択する

**Select the app** で **Bitbucket** を選択し、**Next** をクリックします。

![Bitbucket アプリを選択する](step2.png)

## 4. スコープを選択する

用途に必要な Bitbucket スコープを選択します。

- リポジトリとブランチのインポート・閲覧には、リポジトリの読み取り権限と現在のアカウント情報を読み取る権限が必要です。
- 将来、Git または Bitbucket API でリポジトリへの書き込み、ブランチ作成、Pull Request 作成を行う場合は、対応する書き込みスコープも選択してください。

スクリーンショットでは、スコープアクションを **Read** と **Write** で絞り込む方法を示しています。Knowledge Fabric は Git 操作に独自の追加制限を設けず、トークンで許可されるリモートの読み取り・書き込み操作は Bitbucket の権限に従います。

![Bitbucket scopes を選択する](step3.png)

## 5. 確認してトークンを作成する

名前、有効期限、アプリ、スコープを確認し、**Create token** をクリックします。表示されたら直ちにトークンをコピーしてください。

![API token を確認して作成する](step4.png)

## 6. Knowledge Fabric に接続する

1. **Resource Library** を開き、**Connect Services** に移動します。
2. **Connect Bitbucket Cloud** を選択します。
3. Atlassian アカウントのメールアドレスと、コピーした API トークンを入力します。
4. **Verify and save** をクリックします。`Connected: your email` と表示されれば接続完了です。
5. **Import from Bitbucket** をクリックし、リポジトリと既定ブランチを選択してインポートします。

インポート時に選択した既定ブランチを取得します。大きなリポジトリでは時間がかかることがあります。インポート成功後、リソースライブラリの一覧は自動的に更新されます。

## トラブルシューティング

### リポジトリまたはブランチが表示されない

トークンが有効で、Bitbucket アプリ用に作成され、必要な読み取りスコープを含むことを確認してください。Atlassian アカウント自体が対象 workspace とリポジトリにアクセスできることも確認してください。

### Git の認証に失敗する、またはリポジトリへのアクセスが拒否される

まず、同じアカウントでブラウザから対象リポジトリを開けることを確認してください。開ける場合はトークンを再保存して再試行します。解決しない場合は、トークンのリポジトリ読み取りスコープと有効期限を確認してください。

### トークンが漏えいした、または不要になった

Atlassian API token 管理画面で失効させ、新しいトークンを作成し、Knowledge Fabric で再度 **Verify and save** を実行してください。
