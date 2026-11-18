import {forBrowser} from './connection.mjs';
export const browserId='chrome';
export const connectChrome=options=>forBrowser(browserId,options);
export default connectChrome;
