import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@appica/ui-react/button';
import { User } from '@appica/icons-react';

const params = new URLSearchParams(location.search);
const googleUrl = params.get('google');

function continueWithGoogle(): void {
	if (googleUrl) {
		location.assign(googleUrl);
	}
}

function App() {
	return <section className="auth-card"><div className="auth-icon"><User /></div><h1>Bienvenue sur Appica</h1><p>Connectez-vous pour accéder à votre espace de travail, vos agents et vos outils.</p><div className="auth-actions"><Button className="auth-action auth-action-primary" onClick={continueWithGoogle}>Connexion</Button><Button className="auth-action auth-action-secondary" onClick={continueWithGoogle}>Inscription</Button></div></section>;
}

createRoot(document.getElementById('root')!).render(<App />);
