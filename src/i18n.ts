import i18next from 'i18next';
import Backend from 'i18next-node-fs-backend';
import * as dotenv from 'dotenv';

dotenv.config();

const i18nextInstance = i18next.createInstance();

i18nextInstance
  .use(Backend)
  .init({
    lng: process.env.LANGUAGE,
    backend: {
      loadPath: `${__dirname}/locales/{{lng}}.json`,
    },
    fallbackLng: 'en',
    preload: ['en', 'ru'],
  });

export default i18nextInstance;
