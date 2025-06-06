/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `DatabricksDriver` and related types declaration.
 */

import fetch from 'node-fetch';
import { assertDataSource, getEnv, } from '@cubejs-backend/shared';
import {
  DatabaseStructure,
  DriverCapabilities,
  GenericDataBaseType,
  QueryColumnsResult,
  QueryOptions,
  QuerySchemasResult,
  QueryTablesResult,
  TableColumn,
  UnloadOptions,
} from '@cubejs-backend/base-driver';
import { JDBCDriver, JDBCDriverConfiguration, } from '@cubejs-backend/jdbc-driver';
import { DatabricksQuery } from './DatabricksQuery';
import {
  extractAndRemoveUidPwdFromJdbcUrl,
  parseDatabricksJdbcUrl,
  resolveJDBCDriver
} from './helpers';

const SUPPORTED_BUCKET_TYPES = ['s3', 'gcs', 'azure'];

export type DatabricksDriverConfiguration = JDBCDriverConfiguration &
  {
    /**
     * Driver read-only mode flag.
     */
    readOnly?: boolean,

    /**
     * Export bucket type.
     */
    bucketType?: string,

    /**
     * Export bucket path.
     */
    exportBucket?: string,

    /**
     * Export bucket DBFS mount directory.
     */
    exportBucketMountDir?: string,

    /**
     * Poll interval.
     */
    pollInterval?: number,

    /**
     * The export bucket CSV file escape symbol.
     */
    exportBucketCsvEscapeSymbol?: string,

    /**
     * Export bucket AWS account key.
     */
    awsKey?: string,

    /**
     * Export bucket AWS account secret.
     */
    awsSecret?: string,

    /**
     * Export bucket AWS account region.
     */
    awsRegion?: string,

    /**
     * Export bucket Azure account key.
     */
    azureKey?: string,

    /**
     * Databricks catalog name.
     * https://www.databricks.com/product/unity-catalog
     */
    catalog?: string,

    /**
     * Databricks security token (PWD).
     */
    token?: string,

    /**
     * Databricks OAuth Client ID.
     */
    oauthClientId?: string,

    /**
     * Databricks OAuth Client Secret.
     */
    oauthClientSecret?: string,

    /**
     * Azure tenant Id
     */
    azureTenantId?: string,

    /**
     * Azure service principal client Id
     */
    azureClientId?: string,

    /**
     * Azure service principal client secret
     */
    azureClientSecret?: string,

    /**
     * GCS credentials JSON content
     */
    gcsCredentials?: string,
  };

type ShowTableRow = {
  database: string,
  tableName: string,
  isTemporary: boolean,
};

type ShowDatabasesRow = {
  databaseName: string,
};

type ColumnInfo = {
  name: any;
  type: GenericDataBaseType;
};

export type ParsedConnectionProperties = {
  host: string,
  warehouseId: string,
};

const DatabricksToGenericType: Record<string, string> = {
  binary: 'hll_datasketches',
  'decimal(10,0)': 'bigint',
};

/**
 * Databricks driver class.
 */
export class DatabricksDriver extends JDBCDriver {
  /**
   * Show warning message flag.
   */
  private readonly showSparkProtocolWarn: boolean;

  /**
   * Driver Configuration.
   */
  protected readonly config: DatabricksDriverConfiguration;

  private readonly parsedConnectionProperties: ParsedConnectionProperties;

  private accessToken: string | undefined;

  private accessTokenExpires: number = 0;

  public static dialectClass() {
    return DatabricksQuery;
  }

  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency(): number {
    return 10;
  }

  /**
   * Class constructor.
   */
  public constructor(
    conf: Partial<DatabricksDriverConfiguration> & {
      /**
       * Data source name.
       */
      dataSource?: string,

      /**
       * Max pool size value for the [cube]<-->[db] pool.
       */
      maxPoolSize?: number,

      /**
       * Time to wait for a response from a connection after validation
       * request before determining it as not valid. Default - 10000 ms.
       */
      testConnectionTimeout?: number,
    } = {},
  ) {
    const dataSource =
      conf.dataSource ||
      assertDataSource('default');

    let showSparkProtocolWarn = false;
    let url: string =
      conf?.url ||
      getEnv('databricksUrl', { dataSource }) ||
      getEnv('jdbcUrl', { dataSource });
    if (url.indexOf('jdbc:spark://') !== -1) {
      showSparkProtocolWarn = true;
      url = url.replace('jdbc:spark://', 'jdbc:databricks://');
    }

    const [uid, pwd, cleanedUrl] = extractAndRemoveUidPwdFromJdbcUrl(url);
    const passwd = conf?.token ||
          getEnv('databricksToken', { dataSource }) ||
          pwd;
    const oauthClientId = conf?.oauthClientId || getEnv('databricksOAuthClientId', { dataSource });
    const oauthClientSecret = conf?.oauthClientSecret || getEnv('databricksOAuthClientSecret', { dataSource });

    if (oauthClientId && !oauthClientSecret) {
      throw new Error('Invalid credentials: No OAuth Client Secret provided');
    } else if (!oauthClientId && oauthClientSecret) {
      throw new Error('Invalid credentials: No OAuth Client ID provided');
    } else if (!oauthClientId && !oauthClientSecret && !passwd) {
      throw new Error('No credentials provided');
    }

    let authProps: Record<string, any> = {};

    // OAuth has an advantage over UID+PWD
    // For magic numbers below - see Databricks docs:
    // https://docs.databricks.com/aws/en/integrations/jdbc-oss/configure#authenticate-the-driver
    if (oauthClientId) {
      authProps = {
        OAuth2ClientID: oauthClientId,
        OAuth2Secret: oauthClientSecret,
        AuthMech: 11,
        Auth_Flow: 1,
      };
    } else {
      authProps = {
        UID: uid,
        PWD: passwd,
        AuthMech: 3,
      };
    }

    const config: DatabricksDriverConfiguration = {
      ...conf,
      url: cleanedUrl,
      dbType: 'databricks',
      drivername: 'com.databricks.client.jdbc.Driver',
      customClassPath: undefined,
      properties: {
        ...authProps,
        UserAgentEntry: 'CubeDev_Cube',
      },
      catalog:
        conf?.catalog ||
        getEnv('databricksCatalog', { dataSource }),
      database: getEnv('dbName', { required: false, dataSource }),
      // common export bucket config
      bucketType:
        conf?.bucketType ||
        getEnv('dbExportBucketType', { supported: SUPPORTED_BUCKET_TYPES, dataSource }),
      exportBucket:
        conf?.exportBucket ||
        getEnv('dbExportBucket', { dataSource }),
      exportBucketMountDir:
        conf?.exportBucketMountDir ||
        getEnv('dbExportBucketMountDir', { dataSource }),
      pollInterval: (
        conf?.pollInterval ||
        getEnv('dbPollMaxInterval', { dataSource })
      ) * 1000,
      // AWS export bucket config
      awsKey:
        conf?.awsKey ||
        getEnv('dbExportBucketAwsKey', { dataSource }),
      awsSecret:
        conf?.awsSecret ||
        getEnv('dbExportBucketAwsSecret', { dataSource }),
      awsRegion:
        conf?.awsRegion ||
        getEnv('dbExportBucketAwsRegion', { dataSource }),
      // Azure export bucket
      azureKey:
        conf?.azureKey ||
        getEnv('dbExportBucketAzureKey', { dataSource }),
      exportBucketCsvEscapeSymbol:
        getEnv('dbExportBucketCsvEscapeSymbol', { dataSource }),
      // Azure service principal
      azureTenantId:
        conf?.azureTenantId ||
        getEnv('dbExportBucketAzureTenantId', { dataSource }),
      azureClientId:
        conf?.azureClientId ||
        getEnv('dbExportBucketAzureClientId', { dataSource }),
      azureClientSecret:
        conf?.azureClientSecret ||
        getEnv('dbExportBucketAzureClientSecret', { dataSource }),
      // GCS credentials
      gcsCredentials:
        conf?.gcsCredentials ||
        getEnv('dbExportGCSCredentials', { dataSource }),
    };
    if (config.readOnly === undefined) {
      // we can set readonly to true if there is no bucket config provided
      config.readOnly = !config.exportBucket;
    }

    super(config);
    this.config = config;
    this.parsedConnectionProperties = parseDatabricksJdbcUrl(url);
    this.showSparkProtocolWarn = showSparkProtocolWarn;
  }

  public override readOnly() {
    return !!this.config.readOnly;
  }

  public override capabilities(): DriverCapabilities {
    return {
      unloadWithoutTempTable: true,
      incrementalSchemaLoading: true
    };
  }

  public override setLogger(logger: any) {
    super.setLogger(logger);
    this.showDeprecations();
  }

  private async fetchAccessToken(): Promise<void> {
    // Need to exchange client ID + Secret => Access token

    const basicAuth = Buffer.from(`${this.config.properties.OAuth2ClientID}:${this.config.properties.OAuth2Secret}`).toString('base64');

    const res = await fetch(`https://${this.parsedConnectionProperties.host}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'all-apis',
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to get access token: ${res.statusText}`);
    }

    const resp = await res.json();

    this.accessToken = resp.access_token;
    this.accessTokenExpires = Date.now() + resp.expires_in * 1000 - 60_000;
  }

  private async getValidAccessToken(): Promise<string> {
    if (
      !this.accessToken ||
      !this.accessTokenExpires ||
      Date.now() >= this.accessTokenExpires
    ) {
      await this.fetchAccessToken();
    }
    return this.accessToken!;
  }

  public override async testConnection() {
    let token: string;

    // Databricks docs on accessing REST API
    // https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
    if (this.config.properties.OAuth2Secret) {
      const at = await this.getValidAccessToken();
      token = `Bearer ${at}`;
    } else {
      token = `Bearer ${this.config.properties.PWD}`;
    }

    const res = await fetch(`https://${this.parsedConnectionProperties.host}/api/2.0/sql/warehouses/${this.parsedConnectionProperties.warehouseId}`, {
      headers: { Authorization: token },
    });

    if (!res.ok) {
      throw new Error(`Databricks API error: ${res.statusText}`);
    }

    const data = await res.json();

    if (['DELETING', 'DELETED'].includes(data.state)) {
      throw new Error(`Warehouse is being deleted (current state: ${data.state})`);
    }

    // There is also DEGRADED status, but it doesn't mean that cluster is 100% not working...
    if (data.health?.status === 'FAILED') {
      throw new Error(`Warehouse is unhealthy: ${data.health?.summary}. Details: ${data.health?.details}`);
    }
  }

  public override async loadPreAggregationIntoTable(
    preAggregationTableName: string,
    loadSql: string,
    params: unknown[],
    _options: any,
  ) {
    if (this.config.catalog) {
      const [schema] = preAggregationTableName.split('.');
      return super.loadPreAggregationIntoTable(
        preAggregationTableName,
        loadSql.replace(
          new RegExp(`(?<=\\s)${schema}\\.(?=[^\\s]+)`, 'g'),
          `${this.config.catalog}.${schema}.`
        ),
        params,
        _options,
      );
    } else {
      return super.loadPreAggregationIntoTable(
        preAggregationTableName,
        loadSql,
        params,
        _options,
      );
    }
  }

  public override async query<R = unknown>(
    query: string,
    values: unknown[],
  ): Promise<R[]> {
    if (this.config.catalog) {
      const preAggSchemaName = this.getPreAggrSchemaName();
      return super.query(
        query.replace(
          new RegExp(`(?<=\\s)${preAggSchemaName}\\.(?=[^\\s]+)`, 'g'),
          `${this.config.catalog}.${preAggSchemaName}.`
        ),
        values,
      );
    } else {
      return super.query(query, values);
    }
  }

  /**
   * Returns pre-aggregation schema name.
   */
  protected getPreAggrSchemaName(): string {
    const schema = getEnv('preAggregationsSchema');
    if (schema) {
      return schema;
    } else {
      const devMode =
        process.env.NODE_ENV !== 'production' || getEnv('devMode');
      return devMode
        ? 'dev_pre_aggregations'
        : 'prod_pre_aggregations';
    }
  }

  public override dropTable(tableName: string, options?: QueryOptions): Promise<unknown> {
    const tableFullName = `${
      this.config?.catalog ? `${this.config.catalog}.` : ''
    }${tableName}`;
    return super.dropTable(tableFullName, options);
  }

  private showDeprecations() {
    if (this.config.url) {
      const result = this.config.url
        .split(';')
        .find(node => /^PWD/i.test(node))
        ?.split('=')[1];

      if (result) {
        this.logger('PWD Parameter Deprecation in connection string', {
          warning:
            'PWD parameter is deprecated and will be ignored in future releases. ' +
            'Please migrate to the CUBEJS_DB_DATABRICKS_TOKEN environment variable.'
        });
      }
    }
    if (this.showSparkProtocolWarn) {
      this.logger('jdbc:spark protocol deprecation', {
        warning:
          'The `jdbc:spark` protocol is deprecated and will be ignored in future releases. ' +
          'Please migrate your CUBEJS_DB_DATABRICKS_URL environment variable to the ' +
          '`jdbc:databricks` protocol.'
      });
    }
  }

  protected override async getCustomClassPath() {
    return resolveJDBCDriver();
  }

  /**
   * Execute create schema query.
   */
  public async createSchemaIfNotExists(schemaName: string) {
    await this.query(
      `CREATE SCHEMA IF NOT EXISTS ${
        this.getSchemaFullName(schemaName)
      }`,
      [],
    );
  }

  /**
   * Returns the list of the tables for the specified schema.
   */
  public async getTablesQuery(schemaName: string): Promise<{ 'table_name': string }[]> {
    const response = await this.query(
      `SHOW TABLES IN ${this.getSchemaFullName(schemaName)}`,
      [],
    );
    return response.map((row: any) => ({
      table_name: row.tableName,
    }));
  }

  /**
   * Returns tables meta data object.
   */
  public override async tablesSchema(): Promise<DatabaseStructure> {
    const tables = await this.getTables();

    const metadata: DatabaseStructure = {};

    await Promise.all(tables.map(async ({ database, tableName }) => {
      if (!(database in metadata)) {
        metadata[database] = {};
      }

      metadata[database][tableName] = await this.tableColumnTypes(`${database}.${tableName}`);
    }));

    return metadata;
  }

  /**
   * Returns list of accessible tables.
   */
  private async getTables(): Promise<ShowTableRow[]> {
    if (this.config.database) {
      return <any> this.query<ShowTableRow>(
        `SHOW TABLES IN ${
          this.getSchemaFullName(this.config.database)
        }`,
        [],
      );
    }

    const databases = await this.query<ShowDatabasesRow>(
      `SHOW DATABASES${
        this.config?.catalog
          ? ` IN ${this.quoteIdentifier(this.config.catalog)}`
          : ''
      }`,
      [],
    );

    const tables = await Promise.all(
      databases.map(async ({ databaseName }) => this.query<ShowTableRow>(
        `SHOW TABLES IN ${this.getSchemaFullName(databaseName)}`,
        []
      ))
    );

    return tables.flat();
  }

  public override async getSchemas(): Promise<QuerySchemasResult[]> {
    const databases = await this.query<ShowDatabasesRow>(
      `SHOW DATABASES${
        this.config?.catalog
          ? ` IN ${this.quoteIdentifier(this.config.catalog)}`
          : ''
      }`,
      [],
    );

    return databases.map(({ databaseName }) => ({
      schema_name: databaseName,
    }));
  }

  public override async getTablesForSpecificSchemas(schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]> {
    const tables = await Promise.all(
      // eslint-disable-next-line camelcase
      schemas.map(async ({ schema_name }) => this.query<ShowTableRow>(
        `SHOW TABLES IN ${this.getSchemaFullName(schema_name)}`,
        []
      ))
    );

    return tables.flat().map(({ database, tableName }) => ({
      table_name: tableName,
      schema_name: database,
    }));
  }

  public override async getColumnsForSpecificTables(tables: QueryTablesResult[]): Promise<QueryColumnsResult[]> {
    const columns = await Promise.all(
      // eslint-disable-next-line camelcase
      tables.map(async ({ schema_name, table_name }) => {
        const tableFullName = `${
          this.config?.catalog
            ? `${this.config.catalog}.`
            : ''
        // eslint-disable-next-line camelcase
        }${schema_name}.${table_name}`;
        const columnTypes = await this.tableColumnTypes(tableFullName);
        return columnTypes.map(({ name, type }) => ({
          column_name: name,
          data_type: type,
          // eslint-disable-next-line camelcase
          table_name,
          // eslint-disable-next-line camelcase
          schema_name,
        }));
      })
    );

    return columns.flat();
  }

  /**
   * Returns table columns types.
   */
  public override async tableColumnTypes(table: string): Promise<TableColumn[]> {
    let tableFullName: string;
    const tableArray = table.split('.');

    if (tableArray.length === 3) {
      tableFullName = `${
        this.quoteIdentifier(tableArray[0])
      }.${
        this.quoteIdentifier(tableArray[1])
      }.${
        this.quoteIdentifier(tableArray[2])
      }`;
    } else if (tableArray.length === 2 && this.config?.catalog) {
      tableFullName = `${
        this.quoteIdentifier(this.config.catalog)
      }.${
        this.quoteIdentifier(tableArray[0])
      }.${
        this.quoteIdentifier(tableArray[1])
      }`;
    } else {
      tableFullName = `${
        this.quoteIdentifier(tableArray[0])
      }.${
        this.quoteIdentifier(tableArray[1])
      }`;
    }

    const result = [];
    const response: any[] = await this.query(`DESCRIBE ${tableFullName}`, []);

    for (const column of response) {
      // Databricks describe additional info by default after empty line.
      if (column.col_name === '') {
        break;
      }
      result.push({
        name: column.col_name,
        type: this.toGenericType(column.data_type),
        attributes: [],
      });
    }

    return result;
  }

  /**
   * Returns query columns types.
   */
  public async queryColumnTypes(
    sql: string,
    params?: unknown[]
  ): Promise<ColumnInfo[]> {
    const result = [];

    // eslint-disable-next-line camelcase
    const response = await this.query<{col_name: string; data_type: string}>(
      `DESCRIBE QUERY ${sql}`,
      params || []
    );

    for (const column of response) {
      // Databricks describe additional info by default after empty line.
      if (column.col_name === '') {
        break;
      }

      result.push({ name: column.col_name, type: this.toGenericType(column.data_type) });
    }

    return result;
  }

  /**
   * Returns schema full name.
   */
  private getSchemaFullName(schema: string): string {
    if (this.config?.catalog) {
      return `${
        this.quoteIdentifier(this.config.catalog)
      }.${
        this.quoteIdentifier(schema)
      }`;
    } else {
      return `${this.quoteIdentifier(schema)}`;
    }
  }

  /**
   * Returns quoted string.
   */
  protected quoteIdentifier(identifier: string): string {
    if (identifier.startsWith('`') && identifier.endsWith('`')) {
      return identifier;
    }
    return `\`${identifier}\``;
  }

  /**
   * Returns the JS type by the Databricks type.
   */
  protected toGenericType(columnType: string): string {
    return DatabricksToGenericType[columnType.toLowerCase()] || super.toGenericType(columnType);
  }

  /**
   * Determines whether export bucket feature is configured or not.
   */
  public async isUnloadSupported() {
    return this.config.exportBucket !== undefined;
  }

  /**
   * Returns to the Cubestore an object with links to unloaded to an
   * export bucket data.
   */
  public async unload(tableName: string, options: UnloadOptions) {
    if (!SUPPORTED_BUCKET_TYPES.includes(this.config.bucketType as string)) {
      throw new Error(`Unsupported export bucket type: ${
        this.config.bucketType
      }`);
    }
    const tableFullName = `${
      this.config.catalog
        ? `${this.config.catalog}.`
        : ''
    }${tableName}`;
    const types = options.query
      ? await this.unloadWithSql(
        tableFullName,
        options.query.sql,
        options.query.params,
      )
      : await this.unloadWithTable(tableFullName);
    const csvFile = await this.getCsvFiles(tableFullName);
    return {
      exportBucketCsvEscapeSymbol: this.config.exportBucketCsvEscapeSymbol,
      csvFile,
      types,
      csvNoHeader: true,
    };
  }

  /**
   * Unload data from a SQL query to an export bucket.
   */
  private async unloadWithSql(tableFullName: string, sql: string, params: unknown[]) {
    const types = await this.queryColumnTypes(sql, params);

    await this.createExternalTableFromSql(tableFullName, sql, params, types);

    return types;
  }

  /**
   * Unload data from a temp table to an export bucket.
   */
  private async unloadWithTable(tableFullName: string) {
    const types = await this.tableColumnTypes(tableFullName);

    await this.createExternalTableFromTable(tableFullName, types);

    return types;
  }

  /**
   * Returns an array of signed URLs of unloaded csv files.
   */
  private async getCsvFiles(
    tableName: string,
  ): Promise<string[]> {
    // this.config.exportBucket includes schema
    // so it looks like:
    // s3://real-bucket-name
    // wasbs://real-container-name@account.blob.core.windows.net
    // The extractors in BaseDriver expect just clean bucket name

    if (this.config.bucketType === 'azure') {
      const {
        azureKey,
        azureClientId: clientId,
        azureTenantId: tenantId,
        azureClientSecret: clientSecret
      } = this.config;

      const { bucketName, path, username } = this.parseBucketUrl(this.config.exportBucket);
      const azureBucketPath = `${bucketName}/${username}`;
      const exportPrefix = path ? `${path}/${tableName}` : tableName;

      return this.extractFilesFromAzure(
        { azureKey, clientId, tenantId, clientSecret },
        // Databricks uses different bucket address form, so we need to transform it
        // to the one understandable by extractFilesFromAzure implementation
        azureBucketPath,
        exportPrefix,
      );
    } else if (this.config.bucketType === 's3') {
      const { bucketName, path } = this.parseBucketUrl(this.config.exportBucket);
      const exportPrefix = path ? `${path}/${tableName}` : tableName;

      return this.extractUnloadedFilesFromS3(
        {
          credentials: {
            accessKeyId: this.config.awsKey || '',
            secretAccessKey: this.config.awsSecret || '',
          },
          region: this.config.awsRegion || '',
        },
        bucketName,
        exportPrefix,
      );
    } else if (this.config.bucketType === 'gcs') {
      const { bucketName, path } = this.parseBucketUrl(this.config.exportBucket);
      const exportPrefix = path ? `${path}/${tableName}` : tableName;

      return this.extractFilesFromGCS(
        { credentials: this.config.gcsCredentials },
        bucketName,
        exportPrefix,
      );
    } else {
      throw new Error(`Unsupported export bucket type: ${
        this.config.bucketType
      }`);
    }
  }

  protected generateTableColumnsForExport(columns: ColumnInfo[]): string {
    const wrapped = columns.map((c) => {
      if (c.type === 'hll_datasketches') {
        // [UNSUPPORTED_DATA_TYPE_FOR_DATASOURCE] The CSV datasource doesn't support type \"BINARY\". SQLSTATE: 0A000
        return `base64(${c.name})`;
      } else {
        return c.name;
      }
    });

    return wrapped.join(', ');
  }

  /**
   * Saves specified query to the configured bucket. This requires Databricks
   * cluster to be configured.
   *
   * For Azure blob storage you need to configure account access key in
   * Cluster -> Configuration -> Advanced options
   * https://docs.databricks.com/data/data-sources/azure/azure-storage.html#access-azure-blob-storage-directly
   *
   * `fs.azure.account.key.<storage-account-name>.blob.core.windows.net <storage-account-access-key>`
   *
   * For S3 bucket storage you need to configure AWS access key and secret in
   * Cluster -> Configuration -> Advanced options
   * https://docs.databricks.com/data/data-sources/aws/amazon-s3.html#access-s3-buckets-directly
   *
   * `fs.s3a.access.key <aws-access-key>`
   * `fs.s3a.secret.key <aws-secret-key>`
   *
   * For Google cloud storage you can configure storage credentials and create an external location to access it
   * or configure account service key (legacy)
   * https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/storage-credentials
   * https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/external-locations
   * https://docs.databricks.com/aws/en/connect/storage/gcs
   */
  private async createExternalTableFromSql(tableFullName: string, sql: string, params: unknown[], columns: ColumnInfo[]) {
    let select = sql;

    if (columns.find((column) => column.type === 'hll_datasketches')) {
      select = `SELECT ${this.generateTableColumnsForExport(columns)} FROM (${sql})`;
    }

    try {
      await this.query(
        `
        CREATE TABLE ${tableFullName}_tmp
        USING CSV LOCATION '${this.config.exportBucketMountDir || this.config.exportBucket}/${tableFullName}'
        OPTIONS (escape = '"')
        AS (${select});
        `,
        params,
      );
    } finally {
      await this.query(`DROP TABLE IF EXISTS ${tableFullName}_tmp;`, []);
    }
  }

  /**
   * Saves specified table to the configured bucket. This requires Databricks
   * cluster to be configured.
   *
   * For Azure blob storage you need to configure account access key in
   * Cluster -> Configuration -> Advanced options
   * https://docs.databricks.com/data/data-sources/azure/azure-storage.html#access-azure-blob-storage-directly
   *
   * `fs.azure.account.key.<storage-account-name>.blob.core.windows.net <storage-account-access-key>`
   *
   * For S3 bucket storage you need to configure AWS access key and secret in
   * Cluster -> Configuration -> Advanced options
   * https://docs.databricks.com/data/data-sources/aws/amazon-s3.html#access-s3-buckets-directly
   *
   * `fs.s3a.access.key <aws-access-key>`
   * `fs.s3a.secret.key <aws-secret-key>`
   *
   * For Google cloud storage you can configure storage credentials and create an external location to access it
   * or configure account service key (legacy)
   * https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/storage-credentials
   * https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/external-locations
   * https://docs.databricks.com/aws/en/connect/storage/gcs
   */
  private async createExternalTableFromTable(tableFullName: string, columns: ColumnInfo[]) {
    try {
      await this.query(
        `
        CREATE TABLE ${tableFullName}_tmp
        USING CSV LOCATION '${this.config.exportBucketMountDir || this.config.exportBucket}/${tableFullName}'
        OPTIONS (escape = '"')
        AS SELECT ${this.generateTableColumnsForExport(columns)} FROM ${tableFullName}
        `,
        [],
      );
    } finally {
      await this.query(`DROP TABLE IF EXISTS ${tableFullName}_tmp;`, []);
    }
  }
}
