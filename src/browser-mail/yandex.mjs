import {forBrowser} from './connection.mjs';
export const browserId='yandex';
export const connectYandex=options=>forBrowser(browserId,options);
export default connectYandex;
