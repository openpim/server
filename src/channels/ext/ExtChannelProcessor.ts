import { exec } from "child_process";
import logger from "../../logger";
import { Channel } from "../../models/channels";

export async function extChannelProcessor (tenantId: string, channel: Channel): Promise<void> {
    /* 
        system.exec('c:/tmp/222/l_wb/l_wb_run.bat --context_param token='+data.wbToken, 
      function (error, stdout, stderr) {
       console.log('exec finished', stdout)
        const vals = {expStart: utils.formatDate(date, 'dd-mm-yyyy HH:MM:ss'), expLog:''+stdout, expStop: utils.formatDate(new Date(), 'dd-mm-yyyy HH:MM:ss'), expResult:!error}
        logItem.set('values', vals)
        logItem.save()
        console.log('wb export finished at '+utils.formatDate(new Date(), 'dd-mm-yyyy HH:MM:ss'))
       }
    )  */
    return new Promise(resolve => {
        if (channel.config.extCmd) {
            logger.debug('Starting program :' + channel.config.extCmd + 'channel: ' + channel.identifier + ', tenent: ' + tenantId)
            try {
                exec(channel.config.extCmd, function (error: any, stdout: string, stderr: string) {
                    logger.debug('exec finished for channel: ' + channel.identifier + ', tenent: ' + tenantId)
                    console.log(111, error.code)
                    console.log(222, stdout)
                    console.log(3333, stderr)
                    resolve()
                })
            } catch (err) {
                logger.error('Failed to exec ' + channel.config.extCmd, err)
            }
        } else {
            logger.warn('Command is not defined for channel: ' + channel.identifier + ', tenent: ' + tenantId)
            resolve()
        }
    })
}