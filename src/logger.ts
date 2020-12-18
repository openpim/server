import * as winston from 'winston'

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY/MM/DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.label({ message: false }),
    winston.format.printf(
      info => `${info.timestamp} [${info.level}]: ${info.label ? info.label + ":" : ""} ${info.stack ? "" : info.message} ${info.stack ? info.stack : ""}`
    )
  ),
  transports: [
    new winston.transports.Console({ stderrLevels: ['error'] }),
  ],
});

export default logger