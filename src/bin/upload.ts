import AdmZip from 'adm-zip';
import { program } from 'commander';
import { randomUUID } from 'crypto';
import cliProgress from 'cli-progress';
import {
  host, hostWeb, getConfig, createSupabaseClient,
  updateOrCreateChannel, updateOrCreateVersion, formatError, findSavedKey, checkPlan
} from './utils';

interface Options {
  version: string
  path: string
  apikey: string
  channel?: string
  external?: string
}

const maxMb = 30;
const alertMb = 25;

export const uploadVersion = async (appid: string, options: Options) => {
  let { version, path, channel } = options;
  const { external } = options;
  const apikey = options.apikey || findSavedKey()
  channel = channel || 'dev';
  const config = await getConfig();
  appid = appid || config?.app?.appId
  version = version || config?.app?.package?.version
  path = path || config?.app?.webDir
  if (!apikey) {
    program.error("Missing API key, you need to provide a API key to add your app");
  }
  if (!appid || !version || !path) {
    program.error("Missing argument, you need to provide a appid and a version and a path, or be in a capacitor project");
  }
  console.log(`Upload ${appid}@${version} started from path "${path}" to Capgo cloud`);

  const supabase = createSupabaseClient(apikey)
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true
  }, cliProgress.Presets.shades_grey);

  // add bars
  const b1 = multibar.create(7, 0, {
    format: 'Uploading: [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} Part'
  }, cliProgress.Presets.shades_grey);
  b1.start(7, 0, {
    speed: "N/A"
  });
  // checking if user has access rights before uploading
  const { data: apiAccess, error: apiAccessError } = await supabase
    .rpc('is_allowed_capgkey', { apikey, keymode: ['upload', 'write', 'all'], app_id: appid })

  if (!apiAccess || apiAccessError) {
    multibar.stop()
    program.error(`Invalid API key or insufisant rights ${formatError(apiAccessError)}`);
  }
  b1.increment();

  // checking if user has access rights before uploading
  const { data: versionExist, error: versionExistError } = await supabase
    .rpc('exist_app_versions', { apikey, name_version: version, appid })

  if (versionExist || versionExistError) {
    multibar.stop()
    program.error(`This app version already exist or was deleted, you cannot re-upload it ${formatError(versionExistError)}`);
  }
  b1.increment();

  const { data, error: userIdError } = await supabase
    .rpc<string>('get_user_id', { apikey })

  const userId = data ? data.toString() : '';
  if (!userId || userIdError) {
    multibar.stop()
    program.error(`Cannot verify user ${formatError(userIdError)}`);
  }
  await checkPlan(supabase, userId, false)
  const { data: isTrial, error: isTrialsError } = await supabase
    .rpc<number>('is_trial', { userid: userId })
    .single()
  if (isTrial && isTrial > 0 || isTrialsError) {
    multibar.log(`WARNING !!\nTrial expires in ${isTrial} days, upgrade here: ${hostWeb}/app/usage\n`);
  }
  b1.increment();

  const { data: app, error: dbError0 } = await supabase
    .rpc<string>('exist_app', { appid, apikey })
  if (!app || dbError0) {
    multibar.stop()
    program.error(`Cannot find app ${appid} in your account \n${formatError(dbError0)}`)
  }
  b1.increment();
  const fileName = randomUUID()
  if (!external) {
    const zip = new AdmZip();
    zip.addLocalFolder(path);
    const zipped = zip.toBuffer();
    const mbSize = Math.floor(zipped.byteLength / 1024 / 1024);
    const filePath = `apps/${userId}/${appid}/versions`
    b1.increment();
    if (mbSize > maxMb) {
      multibar.stop()
      program.error(`The app is too big, the limit is ${maxMb} Mb, your is ${mbSize} Mb`);
    }
    if (mbSize > alertMb) {
      multibar.log(`WARNING !!\nThe app size is ${mbSize} Mb, the limit is ${maxMb} Mb\n`);
    }

    const { error: upError } = await supabase.storage
      .from(filePath)
      .upload(fileName, zipped, {
        contentType: 'application/zip',
      })
    if (upError) {
      multibar.stop()
      program.error(`Cannot upload ${formatError(upError)}`)
    }
  } else if (external && !external.startsWith('https://')) {
    multibar.stop()
    program.error(`External link should should start with "https://" current is "${external}"`)
  }
  b1.increment();
  const { data: versionData, error: dbError } = await updateOrCreateVersion(supabase, {
    bucket_id: external ? undefined : fileName,
    user_id: userId,
    name: version,
    app_id: appid,
    external_url: external,
  }, apikey)
  if (dbError) {
    multibar.stop()
    program.error(`Cannot add version ${formatError(dbError)}`)
  }
  b1.increment();
  if (versionData && versionData.length) {
    const { error: dbError3 } = await updateOrCreateChannel(supabase, {
      name: channel,
      app_id: appid,
      created_by: userId,
      version: versionData[0].id,
    }, apikey)
    if (dbError3) {
      multibar.log('Cannot set version with upload key, use key with more rights for that\n');
    }
  } else {
    multibar.log('Cannot set version with upload key, use key with more rights for that\n');
  }
  multibar.stop()
  console.log("App uploaded to server")
  console.log(`Try it in mobile app: ${host}/app_mobile`)
  console.log(`Or set the channel ${channel} as public here: ${hostWeb}/app/package/${appid}`)
  console.log("To use with live update in your own app")
}