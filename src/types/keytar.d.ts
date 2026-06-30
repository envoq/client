declare module 'keytar' {
    export function setPassword(service: string, account: string, password: string): Promise<void>;
    export function getPassword(service: string, account: string): Promise<string | null>;
    export function deletePassword(service: string, account: string): Promise<boolean>;

    const keytar: {
        setPassword: typeof setPassword;
        getPassword: typeof getPassword;
        deletePassword: typeof deletePassword;
    };

    export default keytar;
}
